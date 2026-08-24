import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { MetricsRepository } from "../metrics/metrics.repository";
import { CoachRepository } from "./coach.repository";
import { CoachGroupsRepository } from "./coach-groups.repository";
import { CoachDashboardRepository } from "./coach-dashboard.repository";
import { CoachDashboardService } from "./coach-dashboard.service";

// Test d'intégration contre la vraie base Postgres locale (ticket #2 §25) :
// fixtures réalistes (coach + groupe "Élite" A/B/C + D hors groupe) et
// instrumentation du nombre de requêtes Prisma pour prouver que
// CoachDashboardService n'exécute jamais de boucle par athlète (ticket §3).
// Fixtures jetables nettoyées en afterEach via cascade sur app_user.
describe("CoachDashboardService — fixtures réalistes + performance (intégration Postgres)", () => {
  let prisma: PrismaService;
  const runId = Date.now();
  const createdUserIds: string[] = [];
  const createdCompetitionIds: string[] = [];
  let counter = 0;

  beforeAll(() => {
    prisma = new PrismaService();
  }, 30000);

  afterEach(async () => {
    if (createdCompetitionIds.length > 0) {
      await prisma.competition.deleteMany({ where: { id: { in: createdCompetitionIds } } });
      createdCompetitionIds.length = 0;
    }
    if (createdUserIds.length > 0) {
      await prisma.app_user.deleteMany({ where: { id: { in: createdUserIds } } });
      createdUserIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  }, 30000);

  // Compte chaque appel de méthode sur un model delegate Prisma
  // (prisma.athlete.findMany, prisma.weight_log.findMany, etc.), sans
  // changer le comportement réel des requêtes — instrumentation locale au
  // test, aucune modification de PrismaService lui-même.
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

  function buildService(proxiedPrisma: PrismaService): CoachDashboardService {
    const metricsRepository = new MetricsRepository(proxiedPrisma);
    return new CoachDashboardService(
      new CoachRepository(proxiedPrisma),
      new CoachGroupsRepository(proxiedPrisma),
      new CoachDashboardRepository(proxiedPrisma, metricsRepository),
    );
  }

  async function makeAthlete(prenom: string, nom: string): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-perf-${runId}-${counter}@test.fr`, nom, prenom },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id, categorie_age: "senior" } });
    return athlete.id;
  }

  async function makeCoach(): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-perf-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `F${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return profile.id;
  }

  async function makeCompetition(name: string, daysFromNow: number): Promise<string> {
    const competition = await prisma.competition.create({
      data: { nom: `${name} ${runId}`, date_debut: new Date(Date.now() + daysFromNow * 86400000) },
    });
    createdCompetitionIds.push(competition.id);
    return competition.id;
  }

  it("dashboard global = A/B/C/D, filtre groupe Élite = A/B/C, données nulles gérées, compétitions groupées, requêtes constantes", async () => {
    const coachId = await makeCoach();
    const athleteA = await makeAthlete("Kais", "Ali");
    const athleteB = await makeAthlete("Adam", "Zidane");
    const athleteC = await makeAthlete("Léa", "Martin");
    const athleteD = await makeAthlete("Paul", "Durand"); // hors groupe, sans aucune donnée

    for (const id of [athleteA, athleteB, athleteC, athleteD]) {
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: id } });
    }

    const eliteGroup = await prisma.coach_group.create({ data: { coach_id: coachId, name: `Élite ${runId}` } });
    for (const id of [athleteA, athleteB, athleteC]) {
      await prisma.coach_group_athlete.create({ data: { group_id: eliteGroup.id, athlete_id: id } });
    }

    const parisOpen = await makeCompetition("Paris Open", 18);
    await prisma.participation.create({ data: { athlete_id: athleteA, competition_id: parisOpen, categorie_poids: "-74kg" } });
    await prisma.participation.create({ data: { athlete_id: athleteB, competition_id: parisOpen, categorie_poids: "-68kg" } });

    const regional = await makeCompetition("Régional IDF", 32);
    await prisma.participation.create({ data: { athlete_id: athleteC, competition_id: regional, categorie_poids: "-58kg" } });

    await prisma.weight_log.create({ data: { athlete_id: athleteA, valeur_kg: 74.5, date_mesure: new Date() } });
    await prisma.weight_target.create({ data: { athlete_id: athleteA, poids_cible_kg: 74.0, actif: true } });
    // athleteD : aucune donnée nulle part (weight/metrics/participation/training/goal).

    const { proxied, count } = withQueryCounter(prisma);
    const service = buildService(proxied);

    const fullDashboard = await service.getAthleteSummaries(coachId);
    const queryCountFor4 = count();

    expect(fullDashboard.map((a) => a.id).sort()).toEqual([athleteA, athleteB, athleteC, athleteD].sort());

    const eliteOnly = await service.getAthleteSummaries(coachId, eliteGroup.id);
    expect(eliteOnly.map((a) => a.id).sort()).toEqual([athleteA, athleteB, athleteC].sort());
    expect(eliteOnly.some((a) => a.id === athleteD)).toBe(false);

    // athleteD : entièrement null, jamais un crash ni une valeur fictive.
    const athleteDSummary = fullDashboard.find((a) => a.id === athleteD)!;
    expect(athleteDSummary.weight).toEqual({
      currentWeight: null,
      measuredAt: null,
      target: null,
      differenceToTarget: null,
      weeklyChange: null,
    });
    expect(athleteDSummary.nextCompetition).toBeNull();
    expect(athleteDSummary.nextTraining).toBeNull();
    expect(athleteDSummary.primaryGoal).toBeNull();
    expect(athleteDSummary.groups).toEqual([]);

    const dashboard = await service.getDashboard(coachId);
    expect(dashboard.summary.athleteCount).toBe(4);
    expect(dashboard.summary.groupCount).toBe(1);

    // Deux compétitions distinctes, triées par date croissante ; Paris Open
    // regroupe bien les 2 athlètes inscrits, jamais deux entrées séparées.
    expect(dashboard.upcomingCompetitions).toHaveLength(2);
    expect(dashboard.upcomingCompetitions[0].competition.name).toBe(`Paris Open ${runId}`);
    expect(dashboard.upcomingCompetitions[0].athleteCount).toBe(2);
    expect(dashboard.upcomingCompetitions[1].competition.name).toBe(`Régional IDF ${runId}`);
    expect(dashboard.upcomingCompetitions[1].athleteCount).toBe(1);

    // --- Preuve de non-régression N+1 (ticket §3/§25) ---
    // Même pipeline, un seul athlète (via un coach dédié n'ayant que
    // athleteA) : si le nombre de requêtes dépendait du nombre d'athlètes
    // (boucle par athlète), ce compte serait strictement inférieur à celui
    // obtenu avec 4 athlètes. Il doit être identique.
    const soloCoachId = await makeCoach();
    await prisma.coach_athlete.create({ data: { coach_id: soloCoachId, athlete_id: athleteA } });
    const { proxied: proxiedSolo, count: countSolo } = withQueryCounter(prisma);
    const serviceSolo = buildService(proxiedSolo);
    await serviceSolo.getAthleteSummaries(soloCoachId);
    const queryCountFor1 = countSolo();

    expect(queryCountFor1).toBe(queryCountFor4);
    // Documenté dans le rapport final (§20/§21) : ce compte constant est la
    // preuve que le nombre de requêtes ne croît jamais avec le nombre
    // d'athlètes.
    // eslint-disable-next-line no-console
    console.log(`[perf] requêtes Prisma — 1 athlète: ${queryCountFor1}, 4 athlètes: ${queryCountFor4}`);
  }, 30000);
});
