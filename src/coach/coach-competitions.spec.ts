import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { CoachRepository } from "./coach.repository";
import { CoachDashboardRepository } from "./coach-dashboard.repository";
import { MetricsRepository } from "../metrics/metrics.repository";
import { CoachCompetitionsRepository } from "./coach-competitions.repository";
import { CoachCompetitionsService } from "./coach-competitions.service";
import { CoachCompetitionPreparationsRepository } from "./coach-competition-preparations.repository";

// Test d'intégration contre la vraie base Postgres locale (même discipline
// que coach-dashboard.performance.spec.ts) : fixtures réalistes, isolation
// coach A/B, dédup par competition.id, exclusion des participations
// inactives, et preuve de requêtes constantes indépendamment du nombre
// d'athlètes (rapport §6/§27/§28/§17). Fixtures jetables nettoyées en
// afterEach via cascade sur app_user/competition.
describe("CoachCompetitionsService (intégration Postgres)", () => {
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

  function buildService(proxiedPrisma: PrismaService): CoachCompetitionsService {
    const metricsRepository = new MetricsRepository(proxiedPrisma);
    const dashboardRepository = new CoachDashboardRepository(proxiedPrisma, metricsRepository);
    return new CoachCompetitionsService(
      new CoachRepository(proxiedPrisma),
      new CoachCompetitionsRepository(proxiedPrisma, dashboardRepository),
      new CoachCompetitionPreparationsRepository(proxiedPrisma),
    );
  }

  async function makeAthlete(prenom: string, nom: string): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-comp-${runId}-${counter}@test.fr`, nom, prenom },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id, categorie_age: "senior" } });
    return athlete.id;
  }

  async function makeCoach(): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-comp-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `F${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return profile.id;
  }

  async function makeCompetition(name: string, daysFromNow: number, endDaysFromNow?: number): Promise<string> {
    const competition = await prisma.competition.create({
      data: {
        nom: `${name} ${runId}`,
        date_debut: new Date(Date.now() + daysFromNow * 86400000),
        date_fin: endDaysFromNow !== undefined ? new Date(Date.now() + endDaysFromNow * 86400000) : null,
        ville: "Paris",
        pays: "France",
        niveau: "national",
      },
    });
    createdCompetitionIds.push(competition.id);
    return competition.id;
  }

  it("liste upcoming/past : dédup par competition.id, exclut les participations annulées, requêtes constantes", async () => {
    const coachA = await makeCoach();
    const coachB = await makeCoach();
    const athleteA1 = await makeAthlete("Kais", "Ali");
    const athleteA2 = await makeAthlete("Adam", "Zidane");
    const athleteB1 = await makeAthlete("Léa", "Martin"); // coach B, ne doit jamais apparaître côté coach A

    await prisma.coach_athlete.create({ data: { coach_id: coachA, athlete_id: athleteA1 } });
    await prisma.coach_athlete.create({ data: { coach_id: coachA, athlete_id: athleteA2 } });
    await prisma.coach_athlete.create({ data: { coach_id: coachB, athlete_id: athleteB1 } });

    // §27 : 2 athlètes du même coach sur la MÊME compétition -> 1 seule
    // entrée groupée, athleteCount = 2, jamais deux lignes catalogue.
    const parisWT = await makeCompetition("Paris WT", 42);
    await prisma.participation.create({
      data: { athlete_id: athleteA1, competition_id: parisWT, categorie_poids: "-74kg", categorie_age: "senior" },
    });
    await prisma.participation.create({
      data: { athlete_id: athleteA2, competition_id: parisWT, categorie_poids: "-80kg", categorie_age: "senior" },
    });

    // Participation annulée : ne doit compter nulle part (ticket §17).
    const regional = await makeCompetition("Régional annulé", 10);
    await prisma.participation.create({
      data: { athlete_id: athleteA1, competition_id: regional, statut: "annule" },
    });

    // Compétition passée avec résultat -> vue "past", champs bruts exposés.
    const belgianOpen = await makeCompetition("Belgian Open", -20, -19);
    await prisma.participation.create({
      data: { athlete_id: athleteA1, competition_id: belgianOpen, classement: 1, medaille: "or", victoires: 3, defaites: 0 },
    });

    // Compétition du coach B uniquement : isolation stricte, jamais visible pour coach A.
    const otherCityCup = await makeCompetition("Other City Cup", 5);
    await prisma.participation.create({ data: { athlete_id: athleteB1, competition_id: otherCityCup } });

    const { proxied, count } = withQueryCounter(prisma);
    const service = buildService(proxied);

    const result = await service.getCompetitions(coachA);

    expect(result.upcoming).toHaveLength(1);
    expect(result.upcoming[0].competition.name).toBe(`Paris WT ${runId}`);
    expect(result.upcoming[0].athleteCount).toBe(2);
    expect(result.upcoming[0].athletes.map((a) => a.weightCategory).sort()).toEqual(["-74kg", "-80kg"]);
    // Le régional annulé n'apparaît nulle part, ni upcoming ni past.
    expect(result.upcoming.some((g) => g.competition.name.startsWith("Régional"))).toBe(false);
    expect(result.past.some((g) => g.competition.name.startsWith("Régional"))).toBe(false);

    expect(result.past).toHaveLength(1);
    expect(result.past[0].competition.name).toBe(`Belgian Open ${runId}`);
    expect(result.past[0].athletes[0].result).toEqual({ classement: 1, medaille: "or", victoires: 3, defaites: 0 });

    // Isolation coach A/B (jamais Other City Cup pour coach A).
    expect([...result.upcoming, ...result.past].some((g) => g.competition.name.startsWith("Other City Cup"))).toBe(false);

    // Requêtes consommées par le seul appel coachA mesuré ci-dessus (2
    // athlètes) — capturé AVANT tout autre appel sur `proxied`/`count`, pour
    // ne pas cumuler les requêtes de resultB dans cette mesure.
    const queryCountFor2 = count();

    const resultB = await service.getCompetitions(coachB);
    expect(resultB.upcoming).toHaveLength(1);
    expect(resultB.upcoming[0].competition.name).toBe(`Other City Cup ${runId}`);

    // --- Preuve de requêtes constantes (§6) : 1 athlète vs 2 athlètes ---
    const soloCoach = await makeCoach();
    await prisma.coach_athlete.create({ data: { coach_id: soloCoach, athlete_id: athleteA1 } });
    const { proxied: proxiedSolo, count: countSolo } = withQueryCounter(prisma);
    await buildService(proxiedSolo).getCompetitions(soloCoach);

    expect(countSolo()).toBe(queryCountFor2);
    // eslint-disable-next-line no-console
    console.log(`[perf] requêtes Prisma /coach/competitions — 1 athlète: ${countSolo()}, 2 athlètes: ${queryCountFor2}`);
  }, 30000);

  it("détail compétition : multi-catégories, groupes coach par athlète, isolation, 0 participation active -> hero seul", async () => {
    const coachId = await makeCoach();
    const athleteA = await makeAthlete("Kais", "Ali");
    const athleteB = await makeAthlete("Adam", "Zidane");
    const athleteC = await makeAthlete("Léa", "Martin");

    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteA } });
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteB } });
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteC } });

    const eliteGroup = await prisma.coach_group.create({ data: { coach_id: coachId, name: `Élite ${runId}` } });
    await prisma.coach_group_athlete.create({ data: { group_id: eliteGroup.id, athlete_id: athleteA } });
    await prisma.coach_group_athlete.create({ data: { group_id: eliteGroup.id, athlete_id: athleteB } });

    const competitionId = await makeCompetition("Multi Catégories", 30);
    // §28 : A et B sur des catégories DISTINCTES de la même compétition.
    await prisma.participation.create({
      data: { athlete_id: athleteA, competition_id: competitionId, categorie_poids: "-74kg", categorie_age: "senior" },
    });
    await prisma.participation.create({
      data: { athlete_id: athleteB, competition_id: competitionId, categorie_poids: "-80kg", categorie_age: "senior" },
    });
    // C : participation retirée -> absente de la liste affichée mais le lien
    // reste suffisant pour l'accès (vérifié séparément par le guard, pas
    // testé ici — cette suite teste le service, pas le guard HTTP).
    await prisma.participation.create({
      data: { athlete_id: athleteC, competition_id: competitionId, statut: "retire" },
    });

    const service = buildService(prisma);
    const detail = await service.getCompetitionDetail(coachId, competitionId);

    expect(detail.athleteCount).toBe(2);
    expect(detail.athletes.map((a) => a.id).sort()).toEqual([athleteA, athleteB].sort());
    expect(detail.athletes.some((a) => a.id === athleteC)).toBe(false);

    const distinctCategories = new Set(detail.athletes.map((a) => `${a.ageCategory}|${a.weightCategory}`));
    expect(distinctCategories.size).toBe(2);

    const athleteAView = detail.athletes.find((a) => a.id === athleteA)!;
    expect(athleteAView.groups).toEqual([{ id: eliteGroup.id, name: `Élite ${runId}` }]);
    const athleteBView = detail.athletes.find((a) => a.id === athleteB)!;
    expect(athleteBView.groups).toEqual([{ id: eliteGroup.id, name: `Élite ${runId}` }]);

    // Un coach sans AUCUN lien avec cette compétition obtient un roster
    // vide en interrogeant directement le service (le 403 réel est du
    // ressort du guard HTTP, testé dans coach-competitions.controller.spec.ts).
    const strangerCoach = await makeCoach();
    const strangerDetail = await service.getCompetitionDetail(strangerCoach, competitionId);
    expect(strangerDetail.athleteCount).toBe(0);
    expect(strangerDetail.athletes).toEqual([]);
    expect(strangerDetail.competition.name).toBe(`Multi Catégories ${runId}`);
  }, 30000);
});
