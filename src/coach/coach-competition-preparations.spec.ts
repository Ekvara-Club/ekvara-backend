import "dotenv/config";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CoachRepository } from "./coach.repository";
import { CoachDashboardRepository } from "./coach-dashboard.repository";
import { MetricsRepository } from "../metrics/metrics.repository";
import { CoachCompetitionsRepository } from "./coach-competitions.repository";
import { CoachCompetitionsService } from "./coach-competitions.service";
import { CoachCompetitionPreparationsRepository } from "./coach-competition-preparations.repository";
import { CoachCompetitionPreparationsService } from "./coach-competition-preparations.service";

// Test d'intégration contre la vraie base Postgres locale (même discipline
// que coach-competitions.spec.ts) : CRUD réel, contrainte unique en base,
// isolation multi-coach, coexistence participation/préparation, compétition
// sans participation, persistance après retrait du roster. Fixtures
// jetables nettoyées en afterEach via cascade sur app_user/competition (la
// cascade FK ON DELETE CASCADE de coach_competition_preparation vers
// athlete/coach_profile/competition supprime les préparations jetables
// automatiquement, jamais besoin de les nettoyer une par une).
describe("CoachCompetitionPreparationsService (intégration Postgres)", () => {
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

  function buildPreparationsService(): CoachCompetitionPreparationsService {
    return new CoachCompetitionPreparationsService(new CoachRepository(prisma), new CoachCompetitionPreparationsRepository(prisma));
  }

  function buildCompetitionsService(): CoachCompetitionsService {
    const metricsRepository = new MetricsRepository(prisma);
    const dashboardRepository = new CoachDashboardRepository(prisma, metricsRepository);
    return new CoachCompetitionsService(
      new CoachRepository(prisma),
      new CoachCompetitionsRepository(prisma, dashboardRepository),
      new CoachCompetitionPreparationsRepository(prisma),
    );
  }

  async function makeAthlete(prenom: string, nom: string): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-prep-${runId}-${counter}@test.fr`, nom, prenom },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id, categorie_age: "senior" } });
    return athlete.id;
  }

  async function makeCoach(): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-prep-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `F${counter}` },
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

  it("CRUD complet : create -> read (via detail) -> update -> delete, jamais de trace après suppression", async () => {
    const coachId = await makeCoach();
    const athleteId = await makeAthlete("Adam", "X");
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteId } });
    const competitionId = await makeCompetition("Prep CRUD", 40);

    const preparationsService = buildPreparationsService();
    const competitionsService = buildCompetitionsService();

    const created = await preparationsService.createPreparation(coachId, competitionId, {
      athleteId,
      objective: "Podium",
      coachNote: "Travailler la garde",
    });
    expect(created.status).toBe("envisage"); // défaut appliqué (ticket §5)
    expect(created.objective).toBe("Podium");

    const detailAfterCreate = await competitionsService.getCompetitionDetail(coachId, competitionId);
    expect(detailAfterCreate.athletes).toHaveLength(1);
    expect(detailAfterCreate.athletes[0].hasOfficialParticipation).toBe(false);
    expect(detailAfterCreate.athletes[0].preparation).toEqual({
      id: created.id,
      status: "envisage",
      targetAgeCategory: null,
      targetWeightCategory: null,
      objective: "Podium",
      coachNote: "Travailler la garde",
    });

    const updated = await preparationsService.updatePreparation(created.id, { status: "selectionne", targetWeightCategory: "-80kg" });
    expect(updated.status).toBe("selectionne");
    expect(updated.targetWeightCategory).toBe("-80kg");
    expect(updated.coachNote).toBe("Travailler la garde"); // non touché par un update partiel

    await preparationsService.deletePreparation(created.id);
    const detailAfterDelete = await competitionsService.getCompetitionDetail(coachId, competitionId);
    expect(detailAfterDelete.athleteCount).toBe(0);
  }, 30000);

  it("duplicate : pré-vérification service -> 409, ET contrainte unique en base -> 409 (ticket §17/§32)", async () => {
    const coachId = await makeCoach();
    const athleteId = await makeAthlete("Léa", "Martin");
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteId } });
    const competitionId = await makeCompetition("Prep Duplicate", 20);

    const service = buildPreparationsService();
    await service.createPreparation(coachId, competitionId, { athleteId });

    await expect(service.createPreparation(coachId, competitionId, { athleteId })).rejects.toBeInstanceOf(ConflictException);

    // Contrainte unique réelle en base (§32, "ne pas compter uniquement sur
    // findFirst -> create") : un insert direct concurrent, en contournant le
    // pré-check du service, doit lui aussi échouer.
    await expect(
      prisma.coach_competition_preparation.create({
        data: { coach_id: coachId, athlete_id: athleteId, competition_id: competitionId },
      }),
    ).rejects.toThrow();
  }, 30000);

  it("athlete non lié au roster -> 403 ; compétition inexistante -> 404 (ticket §17/§30)", async () => {
    const coachId = await makeCoach();
    const strangerAthleteId = await makeAthlete("Hors", "Roster");
    const competitionId = await makeCompetition("Prep Access", 15);

    const service = buildPreparationsService();
    await expect(service.createPreparation(coachId, competitionId, { athleteId: strangerAthleteId })).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    const athleteId = await makeAthlete("Roster", "Ok");
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteId } });
    await expect(
      service.createPreparation(coachId, "00000000-0000-4000-8000-000000000000", { athleteId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  }, 30000);

  it("multi-coach (ticket §4/§42) : deux coachs liés au même athlète ont des préparations séparées, notes privées jamais visibles de l'autre", async () => {
    const coachA = await makeCoach();
    const coachB = await makeCoach();
    const athleteId = await makeAthlete("Kais", "Dilmi");
    await prisma.coach_athlete.create({ data: { coach_id: coachA, athlete_id: athleteId } });
    await prisma.coach_athlete.create({ data: { coach_id: coachB, athlete_id: athleteId } });
    const competitionId = await makeCompetition("Prep MultiCoach", 25);

    const preparationsService = buildPreparationsService();
    const competitionsService = buildCompetitionsService();

    const prepA = await preparationsService.createPreparation(coachA, competitionId, {
      athleteId,
      objective: "Podium",
      coachNote: "Note privée A",
    });
    const prepB = await preparationsService.createPreparation(coachB, competitionId, { athleteId, status: "envisage" });

    expect(prepA.id).not.toBe(prepB.id); // deux lignes distinctes, jamais une ligne partagée.

    const detailForA = await competitionsService.getCompetitionDetail(coachA, competitionId);
    expect(detailForA.athletes[0].preparation?.objective).toBe("Podium");
    expect(detailForA.athletes[0].preparation?.coachNote).toBe("Note privée A");

    const detailForB = await competitionsService.getCompetitionDetail(coachB, competitionId);
    expect(detailForB.athletes[0].preparation?.objective).toBeNull();
    expect(detailForB.athletes[0].preparation?.coachNote).toBeNull();
    expect(detailForB.athletes[0].preparation?.id).toBe(prepB.id); // jamais l'id de la prep de A.

    // Isolation stricte au niveau repository aussi : coach B ne peut pas
    // retrouver la ligne de coach A même en connaissant son id.
    const repository = new CoachCompetitionPreparationsRepository(prisma);
    expect(await repository.findByCoachAndId(coachB, prepA.id)).toBeNull();
  }, 30000);

  it("coexistence participation officielle + préparation (ticket §40) : jamais de participation dupliquée, suppression de la préparation laisse la participation intacte", async () => {
    const coachId = await makeCoach();
    const athleteId = await makeAthlete("Test", "Athlete");
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteId } });
    const competitionId = await makeCompetition("Prep Coexistence", 30);
    await prisma.participation.create({
      data: { athlete_id: athleteId, competition_id: competitionId, categorie_poids: "-74kg", categorie_age: "senior" },
    });

    const preparationsService = buildPreparationsService();
    const competitionsService = buildCompetitionsService();

    const created = await preparationsService.createPreparation(coachId, competitionId, { athleteId, status: "selectionne" });

    const detail = await competitionsService.getCompetitionDetail(coachId, competitionId);
    expect(detail.athleteCount).toBe(1); // jamais deux lignes pour le même athlète.
    expect(detail.athletes[0].hasOfficialParticipation).toBe(true);
    expect(detail.athletes[0].weightCategory).toBe("-74kg"); // catégorie OFFICIELLE prime (ticket §7).
    expect(detail.athletes[0].preparation?.status).toBe("selectionne");

    const participationCountBefore = await prisma.participation.count({ where: { athlete_id: athleteId, competition_id: competitionId } });
    expect(participationCountBefore).toBe(1);

    await preparationsService.deletePreparation(created.id);

    const participationCountAfter = await prisma.participation.count({ where: { athlete_id: athleteId, competition_id: competitionId } });
    expect(participationCountAfter).toBe(1); // "Retirer de la préparation" ne touche jamais participation (ticket §15, CRITIQUE).

    const detailAfterRemoval = await competitionsService.getCompetitionDetail(coachId, competitionId);
    expect(detailAfterRemoval.athleteCount).toBe(1); // la participation officielle seule suffit à garder l'athlète visible.
    expect(detailAfterRemoval.athletes[0].preparation).toBeNull();
  }, 30000);

  it("compétition sans participation roster, accessible uniquement via préparation (ticket §21/§22/§41)", async () => {
    const coachId = await makeCoach();
    const athleteId = await makeAthlete("Adam", "Sans Participation");
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteId } });
    const competitionId = await makeCompetition("Prep SansParticipation", 50);

    const preparationsService = buildPreparationsService();
    const competitionsService = buildCompetitionsService();

    await preparationsService.createPreparation(coachId, competitionId, {
      athleteId,
      targetAgeCategory: "senior",
      targetWeightCategory: "-80kg",
    });

    // Apparaît dans /coach/competitions (§24/§25) alors qu'aucune
    // participation officielle n'existe pour aucun athlète du roster.
    const list = await competitionsService.getCompetitions(coachId);
    const entry = list.upcoming.find((g) => g.competition.id === competitionId);
    expect(entry).toBeDefined();
    expect(entry!.athleteCount).toBe(1);
    expect(entry!.athletes[0].weightCategory).toBe("-80kg"); // catégorie PRÉVUE affichée à défaut d'officielle.
    expect(entry!.athletes[0].participationStatus).toBeNull();

    // Détail directement accessible aussi (le guard HTTP réel est testé dans
    // coach-competitions.controller.spec.ts ; ici on vérifie le service).
    const detail = await competitionsService.getCompetitionDetail(coachId, competitionId);
    expect(detail.athletes[0].hasOfficialParticipation).toBe(false);
  }, 30000);

  it("retrait du roster (ticket §31) : la préparation reste en base pour historique mais n'est plus affichée", async () => {
    const coachId = await makeCoach();
    const athleteId = await makeAthlete("Retire", "DuRoster");
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteId } });
    const competitionId = await makeCompetition("Prep RetraitRoster", 35);

    const preparationsService = buildPreparationsService();
    const competitionsService = buildCompetitionsService();
    const created = await preparationsService.createPreparation(coachId, competitionId, { athleteId });

    // Retrait du roster = suppression app-level de coach_athlete UNIQUEMENT
    // (même comportement que CoachRepository.removeCoachAthlete) — jamais de
    // suppression de l'athlete lui-même, donc jamais de cascade FK ici.
    await prisma.coach_athlete.delete({ where: { coach_id_athlete_id: { coach_id: coachId, athlete_id: athleteId } } });

    const stillInDb = await prisma.coach_competition_preparation.findUnique({ where: { id: created.id } });
    expect(stillInDb).not.toBeNull(); // historique conservé.

    const detail = await competitionsService.getCompetitionDetail(coachId, competitionId);
    expect(detail.athleteCount).toBe(0); // plus affiché comme si le coach pouvait encore agir dessus.

    const list = await competitionsService.getCompetitions(coachId);
    expect(list.upcoming.some((g) => g.competition.id === competitionId)).toBe(false);
  }, 30000);

  it("multi-source (ticket §43) : une compétition avec plusieurs competition_source reste une seule préparation, une seule entrée", async () => {
    const coachId = await makeCoach();
    const athleteId = await makeAthlete("Multi", "Source");
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteId } });
    const competitionId = await makeCompetition("Prep MultiSource", 45);

    await prisma.competition_source.create({
      data: { competition_id: competitionId, source: "fftda", source_external_id: `fftda-${runId}` },
    });
    await prisma.competition_source.create({
      data: { competition_id: competitionId, source: "martial_events", source_external_id: `me-${runId}` },
    });

    const preparationsService = buildPreparationsService();
    const competitionsService = buildCompetitionsService();
    await preparationsService.createPreparation(coachId, competitionId, { athleteId });

    const list = await competitionsService.getCompetitions(coachId);
    const matches = list.upcoming.filter((g) => g.competition.id === competitionId);
    expect(matches).toHaveLength(1); // jamais une entrée par source.
  }, 30000);
});
