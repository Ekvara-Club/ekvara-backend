import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { MetricsRepository } from "../metrics/metrics.repository";
import { CoachRepository } from "./coach.repository";
import { CoachGroupsRepository } from "./coach-groups.repository";
import { CoachDashboardRepository } from "./coach-dashboard.repository";
import { CoachDashboardService } from "./coach-dashboard.service";

// Intégration Postgres réelle : la lecture "prochaine compétition" d'un
// athlète côté Coach dépend de filtres/tris/isolation Prisma qu'un mock ne
// valide pas (préparations de CE coach uniquement, dates, statuts).
// Fixtures préfixées, nettoyées en afterAll ; aucune donnée réelle touchée.
describe("Coach — prochaine compétition d'un athlète (préparations + participations, Postgres réel)", () => {
  let prisma: PrismaService;
  let service: CoachDashboardService;

  const runId = Date.now();
  const NOTE_A = `NOTE-SECRETE-COACH-A-${runId}`;
  const NOTE_B = `NOTE-SECRETE-COACH-B-${runId}`;

  const userIds: string[] = [];
  const competitionIds: string[] = [];
  let athleteId: string;
  let coachA: string;
  let coachB: string;
  const comp: Record<"past" | "today" | "oct" | "mar" | "apr", string> = { past: "", today: "", oct: "", mar: "", apr: "" };

  const todayUtcMidnight = (() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  })();
  const daysFromToday = (offset: number) => new Date(todayUtcMidnight.getTime() + offset * 86_400_000);

  async function makeUser(label: string) {
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-coach-next-${label}-${runId}@test.fr`, nom: label, prenom: "Fixture" },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function makeCompetition(key: keyof typeof comp, offset: number) {
    const c = await prisma.competition.create({
      data: { nom: `Fixture next ${key} ${runId}`, date_debut: daysFromToday(offset), ville: "Eaubonne", pays: "France", niveau: "national" },
    });
    comp[key] = c.id;
    competitionIds.push(c.id);
  }

  const prep = (
    coachId: string,
    competitionId: string,
    data: { statut?: string; age?: string | null; poids?: string | null; note?: string } = {},
  ) =>
    prisma.coach_competition_preparation.create({
      data: {
        coach_id: coachId,
        athlete_id: athleteId,
        competition_id: competitionId,
        statut: data.statut ?? "pret",
        categorie_age_prevue: data.age === undefined ? "Senior" : data.age,
        categorie_poids_prevue: data.poids === undefined ? "-68kg" : data.poids,
        note_coach: data.note,
      },
    });

  const next = async (coachId: string) => (await service.getAthleteDashboard(coachId, athleteId)).nextCompetition;

  const cleanup = async () => {
    await prisma.coach_competition_preparation.deleteMany({ where: { competition_id: { in: competitionIds } } });
    await prisma.participation.deleteMany({ where: { competition_id: { in: competitionIds } } });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    service = new CoachDashboardService(
      new CoachRepository(prisma),
      new CoachGroupsRepository(prisma),
      new CoachDashboardRepository(prisma, new MetricsRepository(prisma)),
    );

    athleteId = (await prisma.athlete.create({ data: { user_id: await makeUser("Athlete") } })).id;
    coachA = (await prisma.coach_profile.create({ data: { user_id: await makeUser("CoachA") } })).id;
    coachB = (await prisma.coach_profile.create({ data: { user_id: await makeUser("CoachB") } })).id;
    await prisma.coach_athlete.createMany({
      data: [
        { coach_id: coachA, athlete_id: athleteId },
        { coach_id: coachB, athlete_id: athleteId },
      ],
    });
    await makeCompetition("past", -10);
    await makeCompetition("today", 0);
    await makeCompetition("oct", 19);
    await makeCompetition("mar", 173);
    await makeCompetition("apr", 200);
  }, 30000);

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await prisma.coach_athlete.deleteMany({ where: { athlete_id: athleteId } });
    await prisma.competition.deleteMany({ where: { id: { in: competitionIds } } });
    await prisma.coach_profile.deleteMany({ where: { id: { in: [coachA, coachB] } } });
    await prisma.athlete.deleteMany({ where: { id: athleteId } });
    await prisma.app_user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }, 30000);

  it("1 : athlète sans compétition -> null (empty state)", async () => {
    expect(await next(coachA)).toBeNull();
  });

  it("2/9/10 : préparation future -> prochaine compétition avec catégories âge/poids et statut", async () => {
    await prep(coachA, comp.mar, { statut: "pret", age: "Senior", poids: "-68kg" });

    expect(await next(coachA)).toMatchObject({
      source: "coach_preparation",
      id: comp.mar,
      city: "Eaubonne",
      country: "France",
      weightCategory: null,
      preparation: { status: "pret", targetAgeCategory: "Senior", targetWeightCategory: "-68kg" },
      daysUntil: 173,
    });
  });

  it("3 : plusieurs préparations -> la date future la plus proche (pas la plus éloignée)", async () => {
    await prep(coachA, comp.apr);
    await prep(coachA, comp.mar);
    await prep(coachA, comp.oct);

    expect(await next(coachA)).toMatchObject({ id: comp.oct });
  });

  it("4 : compétition passée ignorée", async () => {
    await prep(coachA, comp.past);
    expect(await next(coachA)).toBeNull();

    await prep(coachA, comp.mar);
    expect(await next(coachA)).toMatchObject({ id: comp.mar });
  });

  it("compétition d'aujourd'hui (DATE) reste éligible, comme côté Athlete", async () => {
    await prep(coachA, comp.today);

    expect(await next(coachA)).toMatchObject({ id: comp.today, daysUntil: 0 });
  });

  it("5 : forfait -> jamais prochaine compétition (règle #13), la suivante active est retenue", async () => {
    await prep(coachA, comp.oct, { statut: "forfait" });
    expect(await next(coachA)).toBeNull();

    await prep(coachA, comp.mar, { statut: "selectionne" });
    expect(await next(coachA)).toMatchObject({ id: comp.mar, preparation: { status: "selectionne" } });
  });

  it("6 : participation seule -> prochaine compétition (source participation)", async () => {
    await prisma.participation.create({ data: { athlete_id: athleteId, competition_id: comp.mar, categorie_poids: "-74 kg", categorie_age: "cadet" } });

    expect(await next(coachA)).toMatchObject({
      source: "participation",
      id: comp.mar,
      weightCategory: "-74 kg",
      ageCategory: "cadet",
      preparation: null,
    });
  });

  it("7 : participation + préparation sur la même compétition -> UNE seule, catégories officielles non falsifiées", async () => {
    await prisma.participation.create({ data: { athlete_id: athleteId, competition_id: comp.mar, categorie_poids: "-74 kg", categorie_age: "cadet" } });
    await prep(coachA, comp.mar, { poids: "-68kg" });

    expect(await next(coachA)).toMatchObject({
      source: "participation",
      id: comp.mar,
      weightCategory: "-74 kg",
      ageCategory: "cadet",
      preparation: { status: "pret", targetWeightCategory: "-68kg" },
    });

    const dashboard = await service.getDashboard(coachA);
    const entries = dashboard.upcomingCompetitions.filter((c) => c.competition.id === comp.mar);
    expect(entries).toHaveLength(1);
    expect(entries[0].athleteCount).toBe(1);
  });

  it("participation annulée/retirée : la préparation du coach n'est pas présentée seule", async () => {
    await prisma.participation.create({ data: { athlete_id: athleteId, competition_id: comp.mar, statut: "retire" } });
    await prep(coachA, comp.mar);

    expect(await next(coachA)).toBeNull();
  });

  it("8/12 : ISOLATION — la préparation d'un autre coach n'est jamais utilisée comme celle du coach courant", async () => {
    await prep(coachB, comp.oct, { poids: "-80kg", note: NOTE_B }); // plus proche, mais à Coach B
    await prep(coachA, comp.mar, { poids: "-68kg", note: NOTE_A });

    const seenByA = await next(coachA);
    expect(seenByA).toMatchObject({ id: comp.mar, preparation: { targetWeightCategory: "-68kg" } });

    const seenByB = await next(coachB);
    expect(seenByB).toMatchObject({ id: comp.oct, preparation: { targetWeightCategory: "-80kg" } });
  });

  it("8 : même compétition préparée par deux coachs -> chacun ne voit QUE ses catégories/statut", async () => {
    await prep(coachA, comp.mar, { statut: "pret", poids: "-68kg" });
    await prep(coachB, comp.mar, { statut: "envisage", poids: "-74kg" });

    expect(await next(coachA)).toMatchObject({ preparation: { status: "pret", targetWeightCategory: "-68kg" } });
    expect(await next(coachB)).toMatchObject({ preparation: { status: "envisage", targetWeightCategory: "-74kg" } });
  });

  it("aucune note coach dans les réponses (fiche athlète, dashboard), ni la sienne ni celle d'un autre coach", async () => {
    await prep(coachA, comp.mar, { note: NOTE_A });
    await prep(coachB, comp.mar, { note: NOTE_B });

    const serialized = JSON.stringify([await service.getAthleteDashboard(coachA, athleteId), await service.getDashboard(coachA)]);

    expect(serialized).not.toContain(NOTE_A);
    expect(serialized).not.toContain(NOTE_B);
    expect(serialized).not.toMatch(/note_coach|coachNote|objectif/);
  });

  it("11 : lire la fiche ne crée, ne modifie, ne supprime aucune participation ni préparation", async () => {
    await prep(coachA, comp.mar);
    // Comptes restreints à NOS fixtures : d'autres suites d'intégration
    // écrivent en parallèle dans les mêmes tables, un compte global serait flaky.
    const ours = { competition_id: { in: competitionIds } };
    const beforePreparations = await prisma.coach_competition_preparation.count({ where: ours });

    await next(coachA);
    await service.getDashboard(coachA);

    expect(await prisma.coach_competition_preparation.count({ where: ours })).toBe(beforePreparations);
    expect(await prisma.participation.count({ where: ours })).toBe(0);
    expect(await prisma.participation.count({ where: { athlete_id: athleteId } })).toBe(0);
  });
});
