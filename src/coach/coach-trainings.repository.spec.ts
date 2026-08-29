import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { CoachTrainingsRepository, TrainingFieldsSnapshot } from "./coach-trainings.repository";

// Signature createSessionWithAssignments/replaceAssignments élargie (ticket
// "Présences Coach V1") pour porter group_id par athlète — sans intérêt pour
// ces tests, qui n'exercent que la transaction de base.
function athletesOf(...athleteIds: string[]): { athleteId: string; groupId: string | null }[] {
  return athleteIds.map((athleteId) => ({ athleteId, groupId: null }));
}

// Test d'intégration contre la vraie base Postgres locale : la transaction
// de création (session + N training_session + N assignments), la
// propagation batch, et le remplacement complet des assignments dépendent de
// comportements Postgres réels (voir CompetitionEntriesRepository.spec.ts
// pour le même principe). Fixtures jetables nettoyées en afterEach via
// cascade sur app_user.
describe("CoachTrainingsRepository (intégration Postgres)", () => {
  let prisma: PrismaService;
  let repository: CoachTrainingsRepository;
  const runId = Date.now();
  const createdUserIds: string[] = [];
  let counter = 0;

  beforeAll(() => {
    prisma = new PrismaService();
    repository = new CoachTrainingsRepository(prisma);
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

  async function makeCoach(): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-ct-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `F${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return profile.id;
  }

  async function makeAthlete(): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-ct-athlete-${runId}-${counter}@test.fr`, nom: `N${counter}`, prenom: `P${counter}` },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
    return athlete.id;
  }

  function fields(overrides: Partial<TrainingFieldsSnapshot> = {}): TrainingFieldsSnapshot {
    return { titre: `Séance ${runId}`, date_debut: new Date("2026-09-05T18:00:00.000Z"), ...overrides };
  }

  describe("createSessionWithAssignments", () => {
    it("crée la session, N training_session, N assignments et les group_sources en une transaction", async () => {
      const coachId = await makeCoach();
      const athleteA = await makeAthlete();
      const athleteB = await makeAthlete();
      const group = await prisma.coach_group.create({ data: { coach_id: coachId, name: `Elite ${runId}` } });

      const sessionId = await repository.createSessionWithAssignments(
        coachId,
        fields(),
        athletesOf(athleteA, athleteB),
        [group.id],
      );

      const detail = await repository.findSessionDetail(sessionId);
      expect(detail?.assignments).toHaveLength(2);
      expect(detail?.assignments.map((a) => a.athlete.id).sort()).toEqual([athleteA, athleteB].sort());
      expect(detail?.group_sources.map((g) => g.coach_group.id)).toEqual([group.id]);

      // Les training_session générés sont indiscernables d'une séance créée
      // directement par l'athlète : mêmes champs, athlete_id direct.
      const generated = await prisma.training_session.findMany({ where: { athlete_id: { in: [athleteA, athleteB] } } });
      expect(generated).toHaveLength(2);
      expect(generated.every((t) => t.titre === `Séance ${runId}`)).toBe(true);
    });

    it("aucun athlète -> zéro training_session créé, mais la session existe (cas groupIds pointant vers un groupe vide, accepté au niveau repository — la garde \"au moins un destinataire\" vit dans le service)", async () => {
      const coachId = await makeCoach();
      const sessionId = await repository.createSessionWithAssignments(coachId, fields(), [], []);

      const detail = await repository.findSessionDetail(sessionId);
      expect(detail?.assignments).toEqual([]);
    });
  });

  describe("updateContentAndPropagate", () => {
    it("UNE modification de contenu est visible pour TOUS les athlètes assignés (test architectural du ticket §13)", async () => {
      const coachId = await makeCoach();
      const athleteA = await makeAthlete();
      const athleteB = await makeAthlete();
      const sessionId = await repository.createSessionWithAssignments(coachId, fields(), athletesOf(athleteA, athleteB), []);

      const newStart = new Date("2026-09-05T20:30:00.000Z");
      await repository.updateContentAndPropagate(sessionId, { date_debut: newStart });

      const rows = await prisma.training_session.findMany({ where: { athlete_id: { in: [athleteA, athleteB] } } });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.date_debut.getTime() === newStart.getTime())).toBe(true);
    });
  });

  describe("cancel", () => {
    it("propage statut='annule' à la session ET à tous les training_session assignés (soft, aucune ligne supprimée)", async () => {
      const coachId = await makeCoach();
      const athleteA = await makeAthlete();
      const sessionId = await repository.createSessionWithAssignments(coachId, fields(), athletesOf(athleteA), []);

      await repository.cancel(sessionId);

      const session = await prisma.coach_training_session.findUnique({ where: { id: sessionId } });
      const training = await prisma.training_session.findFirst({ where: { athlete_id: athleteA } });
      expect(session?.statut).toBe("annule");
      expect(training?.statut).toBe("annule");
      expect(training).not.toBeNull(); // soft : jamais supprimé
    });
  });

  describe("replaceAssignments", () => {
    it("retire les training_session des athlètes absents du nouvel ensemble, ajoute les nouveaux, conserve les communs", async () => {
      const coachId = await makeCoach();
      const athleteA = await makeAthlete();
      const athleteB = await makeAthlete();
      const athleteC = await makeAthlete();
      const sessionId = await repository.createSessionWithAssignments(coachId, fields(), athletesOf(athleteA, athleteB), []);

      const before = await repository.findCurrentAssignments(sessionId);
      const bTrainingSessionId = before.find((a) => a.athlete_id === athleteB)!.training_session_id;

      // Nouvel ensemble : A (conservé), C (ajouté), B retiré.
      await repository.replaceAssignments(sessionId, fields(), athletesOf(athleteC), [bTrainingSessionId], []);

      const after = await repository.findCurrentAssignments(sessionId);
      expect(after.map((a) => a.athlete_id).sort()).toEqual([athleteA, athleteC].sort());
      expect(await prisma.training_session.findUnique({ where: { id: bTrainingSessionId } })).toBeNull();
    });

    it("idempotent : rejouer le même remplacement ne duplique rien", async () => {
      const coachId = await makeCoach();
      const athleteA = await makeAthlete();
      const group = await prisma.coach_group.create({ data: { coach_id: coachId, name: `G ${runId}` } });
      const sessionId = await repository.createSessionWithAssignments(coachId, fields(), athletesOf(athleteA), [group.id]);

      await repository.replaceAssignments(sessionId, fields(), [], [], [group.id]);
      await repository.replaceAssignments(sessionId, fields(), [], [], [group.id]);

      const assignments = await repository.findCurrentAssignments(sessionId);
      const groupSources = await prisma.coach_training_group_source.findMany({ where: { coach_training_session_id: sessionId } });
      expect(assignments).toHaveLength(1);
      expect(groupSources).toHaveLength(1);
    });

    it("remplace intégralement les group_sources (jamais un ajout cumulatif)", async () => {
      const coachId = await makeCoach();
      const groupA = await prisma.coach_group.create({ data: { coach_id: coachId, name: `GA ${runId}` } });
      const groupB = await prisma.coach_group.create({ data: { coach_id: coachId, name: `GB ${runId}` } });
      const sessionId = await repository.createSessionWithAssignments(coachId, fields(), [], [groupA.id]);

      await repository.replaceAssignments(sessionId, fields(), [], [], [groupB.id]);

      const sources = await prisma.coach_training_group_source.findMany({ where: { coach_training_session_id: sessionId } });
      expect(sources.map((s) => s.group_id)).toEqual([groupB.id]);
    });
  });

  describe("suppression d'un groupe (ticket §21)", () => {
    it("supprime uniquement la provenance (group_source), jamais la session ni les assignments", async () => {
      const coachId = await makeCoach();
      const athleteA = await makeAthlete();
      const group = await prisma.coach_group.create({ data: { coach_id: coachId, name: `G ${runId}` } });
      const sessionId = await repository.createSessionWithAssignments(coachId, fields(), athletesOf(athleteA), [group.id]);

      await prisma.coach_group.delete({ where: { id: group.id } });

      const detail = await repository.findSessionDetail(sessionId);
      expect(detail).not.toBeNull();
      expect(detail?.assignments).toHaveLength(1);
      expect(detail?.group_sources).toEqual([]);
    });
  });

  describe("retrait coach_athlete (ticket §20)", () => {
    it("ne cascade jamais sur les training_session/assignments déjà créés", async () => {
      const coachId = await makeCoach();
      const athleteA = await makeAthlete();
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteA } });
      const sessionId = await repository.createSessionWithAssignments(coachId, fields(), athletesOf(athleteA), []);

      await prisma.coach_athlete.delete({
        where: { coach_id_athlete_id: { coach_id: coachId, athlete_id: athleteA } },
      });

      const detail = await repository.findSessionDetail(sessionId);
      expect(detail?.assignments).toHaveLength(1);
      const training = await prisma.training_session.findFirst({ where: { athlete_id: athleteA } });
      expect(training).not.toBeNull();
    });
  });

  // La résolution/autorisation des destinataires (groupes/athlètes) est
  // désormais testée dans coach-destinataire-resolver.spec.ts, depuis que
  // cette logique a été extraite en composant partagé avec la publication
  // d'exercices (voir CoachDestinataireResolver).
});
