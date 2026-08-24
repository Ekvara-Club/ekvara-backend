import "dotenv/config";
import { ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CoachTrainingsService } from "./coach-trainings.service";
import { CoachTrainingsRepository } from "./coach-trainings.repository";
import { CoachDestinataireResolver } from "./coach-destinataire-resolver";

// Test d'intégration contre la vraie base Postgres locale (ticket §26) :
// fixtures réalistes (coach + groupe Elite A/B/C + groupe Junior C/D +
// athlète E hors groupe + athlète X d'un autre coach), résolution de
// destinataires, rollback complet sur destinataire non autorisé, snapshot de
// groupe (ticket §19), et instrumentation du nombre de requêtes (ticket
// §29). Fixtures jetables nettoyées en afterEach via cascade sur app_user.
describe("CoachTrainingsService — fixtures réalistes (intégration Postgres)", () => {
  let prisma: PrismaService;
  const runId = Date.now();
  const createdUserIds: string[] = [];
  let counter = 0;

  beforeAll(() => {
    prisma = new PrismaService();
  }, 30000);

  afterEach(async () => {
    if (createdUserIds.length > 0) {
      await prisma.app_user.deleteMany({ where: { id: { in: createdUserIds } } });
      createdUserIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  }, 30000);

  function withQueryCounter(target: PrismaService): { proxied: PrismaService; count: () => number } {
    let count = 0;
    const modelProxies = new Map<PropertyKey, unknown>();
    const proxied = new Proxy(target as unknown as Record<PropertyKey, unknown>, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver);
        if (typeof value !== "object" || value === null) return value;
        if (typeof (value as Record<string, unknown>).findMany !== "function") return value;
        if (modelProxies.has(prop)) return modelProxies.get(prop);
        const modelProxy = new Proxy(value as Record<PropertyKey, unknown>, {
          get(modelObj, method, modelReceiver) {
            const fn = Reflect.get(modelObj, method, modelReceiver);
            if (typeof fn !== "function") return fn;
            return (...args: unknown[]) => {
              count++;
              return (fn as (...a: unknown[]) => unknown).apply(modelObj, args);
            };
          },
        });
        modelProxies.set(prop, modelProxy);
        return modelProxy;
      },
    });
    return { proxied: proxied as unknown as PrismaService, count: () => count };
  }

  function buildService(proxiedPrisma: PrismaService): CoachTrainingsService {
    return new CoachTrainingsService(
      new CoachTrainingsRepository(proxiedPrisma),
      new CoachDestinataireResolver(proxiedPrisma),
    );
  }

  async function makeCoach(): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-fx-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `F${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return profile.id;
  }

  async function makeAthlete(prenom: string): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-fx-athlete-${runId}-${counter}@test.fr`, nom: "Test", prenom },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
    return athlete.id;
  }

  it("Elite (A/B/C), Elite+Junior (A/B/C/D), Elite+E (A/B/C/E), athlète X étranger -> 403 + rollback complet, groupe étranger -> 403 + rollback, snapshot groupe, requêtes constantes", async () => {
    const coachId = await makeCoach();
    const otherCoachId = await makeCoach();

    const athleteA = await makeAthlete("A");
    const athleteB = await makeAthlete("B");
    const athleteC = await makeAthlete("C");
    const athleteD = await makeAthlete("D");
    const athleteE = await makeAthlete("E"); // lié au coach, hors groupe
    const athleteX = await makeAthlete("X"); // lié à otherCoachId, jamais à coachId

    for (const id of [athleteA, athleteB, athleteC, athleteD, athleteE]) {
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: id } });
    }
    await prisma.coach_athlete.create({ data: { coach_id: otherCoachId, athlete_id: athleteX } });

    const elite = await prisma.coach_group.create({ data: { coach_id: coachId, name: `Elite ${runId}` } });
    const junior = await prisma.coach_group.create({ data: { coach_id: coachId, name: `Junior ${runId}` } });
    for (const id of [athleteA, athleteB, athleteC]) {
      await prisma.coach_group_athlete.create({ data: { group_id: elite.id, athlete_id: id } });
    }
    for (const id of [athleteC, athleteD]) {
      await prisma.coach_group_athlete.create({ data: { group_id: junior.id, athlete_id: id } });
    }
    const foreignGroup = await prisma.coach_group.create({ data: { coach_id: otherCoachId, name: `Foreign ${runId}` } });

    const service = buildService(prisma);

    // --- Elite seul -> A/B/C ---
    const t1 = await service.createTraining(coachId, {
      title: `T1 ${runId}`,
      startAt: "2026-09-05T18:00:00.000Z",
      groupIds: [elite.id],
    });
    expect(t1.assignments.athletes.map((a) => a.id).sort()).toEqual([athleteA, athleteB, athleteC].sort());

    // --- Elite + Junior -> union A/B/C/D (C dédoublonné, présent dans les deux) ---
    const t2 = await service.createTraining(coachId, {
      title: `T2 ${runId}`,
      startAt: "2026-09-05T18:00:00.000Z",
      groupIds: [elite.id, junior.id],
    });
    expect(t2.assignments.athleteCount).toBe(4);
    expect(t2.assignments.athletes.map((a) => a.id).sort()).toEqual([athleteA, athleteB, athleteC, athleteD].sort());

    // --- Elite + athlète individuel E -> A/B/C/E ---
    const t3 = await service.createTraining(coachId, {
      title: `T3 ${runId}`,
      startAt: "2026-09-05T18:00:00.000Z",
      groupIds: [elite.id],
      athleteIds: [athleteE],
    });
    expect(t3.assignments.athletes.map((a) => a.id).sort()).toEqual([athleteA, athleteB, athleteC, athleteE].sort());

    // --- Destinataire non autorisé (athlète X, autre coach) -> échec complet, rollback ---
    const before = await prisma.coach_training_session.count({ where: { coach_id: coachId } });
    await expect(
      service.createTraining(coachId, {
        title: `T-invalide ${runId}`,
        startAt: "2026-09-05T18:00:00.000Z",
        athleteIds: [athleteA, athleteX],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const afterInvalidAthlete = await prisma.coach_training_session.count({ where: { coach_id: coachId } });
    expect(afterInvalidAthlete).toBe(before); // AUCUNE session créée, même partiellement

    // --- Groupe d'un autre coach -> échec complet, rollback ---
    await expect(
      service.createTraining(coachId, {
        title: `T-invalide-2 ${runId}`,
        startAt: "2026-09-05T18:00:00.000Z",
        groupIds: [foreignGroup.id],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const afterInvalidGroup = await prisma.coach_training_session.count({ where: { coach_id: coachId } });
    expect(afterInvalidGroup).toBe(before);
    // Le groupe étranger lui-même n'a reçu aucune trace de cette tentative.
    expect(await prisma.coach_training_group_source.count({ where: { group_id: foreignGroup.id } })).toBe(0);

    // --- Snapshot groupe (ticket §19) ---
    // T4 créé via Elite (A/B/C). D rejoint Elite APRÈS coup : T4 doit rester A/B/C.
    const t4 = await service.createTraining(coachId, {
      title: `T4 snapshot ${runId}`,
      startAt: "2026-09-05T18:00:00.000Z",
      groupIds: [elite.id],
    });
    expect(t4.assignments.athletes.map((a) => a.id).sort()).toEqual([athleteA, athleteB, athleteC].sort());

    await prisma.coach_group_athlete.create({ data: { group_id: elite.id, athlete_id: athleteD } });

    const t4Unchanged = await service.findOneForCoach(t4.id);
    expect(t4Unchanged.assignments.athletes.map((a) => a.id).sort()).toEqual([athleteA, athleteB, athleteC].sort());

    // PUT assignments avec Elite -> snapshot RECALCULÉ : A/B/C/D.
    const t4Updated = await service.replaceAssignments(coachId, t4.id, { groupIds: [elite.id], athleteIds: [] });
    expect(t4Updated.assignments.athletes.map((a) => a.id).sort()).toEqual(
      [athleteA, athleteB, athleteC, athleteD].sort(),
    );

    // --- Performance (ticket §29) : requêtes constantes, pas une par athlète.
    // Comparaison sur le MÊME chemin de code (athleteIds direct, sans
    // résolution de groupe, qui ajoute sa propre requête constante à part) :
    // seul N (nombre d'athlètes) varie entre les deux appels.
    const { proxied: proxiedSmall, count: countSmall } = withQueryCounter(prisma);
    await buildService(proxiedSmall).createTraining(coachId, {
      title: `Perf 1 athlète ${runId}`,
      startAt: "2026-09-05T18:00:00.000Z",
      athleteIds: [athleteA],
    });
    const queryCountFor1 = countSmall();

    const { proxied: proxiedLarge, count: countLarge } = withQueryCounter(prisma);
    await buildService(proxiedLarge).createTraining(coachId, {
      title: `Perf 4 athlètes ${runId}`,
      startAt: "2026-09-05T18:00:00.000Z",
      athleteIds: [athleteA, athleteB, athleteC, athleteD],
    });
    const queryCountFor4 = countLarge();

    expect(queryCountFor4).toBe(queryCountFor1);
    // eslint-disable-next-line no-console
    console.log(`[perf] requêtes Prisma POST /coach/trainings — 1 athlète: ${queryCountFor1}, 4 athlètes: ${queryCountFor4}`);
  }, 30000);
});
