import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { CoachTrainingsRepository, TrainingFieldsSnapshot } from "./coach-trainings.repository";
import { NotificationsRepository } from "../notifications/notifications.repository";

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
    repository = new CoachTrainingsRepository(prisma, new NotificationsRepository(prisma));
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

  async function makeCoach(): Promise<{ coachId: string; userId: string }> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-ct-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `F${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return { coachId: profile.id, userId: user.id };
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
      const { coachId, userId: actorUserId } = await makeCoach();
      const athleteA = await makeAthlete();
      const athleteB = await makeAthlete();
      const group = await prisma.coach_group.create({ data: { coach_id: coachId, name: `Elite ${runId}` } });

      const sessionId = await repository.createSessionWithAssignments(
        coachId,
        fields(),
        athletesOf(athleteA, athleteB),
        [group.id],
        actorUserId,
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
      const { coachId, userId: actorUserId } = await makeCoach();
      const sessionId = await repository.createSessionWithAssignments(coachId, fields(), [], [], actorUserId);

      const detail = await repository.findSessionDetail(sessionId);
      expect(detail?.assignments).toEqual([]);
    });
  });

  describe("updateContentAndPropagate", () => {
    it("UNE modification de contenu est visible pour TOUS les athlètes assignés (test architectural du ticket §13)", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const athleteA = await makeAthlete();
      const athleteB = await makeAthlete();
      const sessionId = await repository.createSessionWithAssignments(coachId, fields(), athletesOf(athleteA, athleteB), [], actorUserId);

      const newStart = new Date("2026-09-05T20:30:00.000Z");
      await repository.updateContentAndPropagate(sessionId, { date_debut: newStart }, null);

      const rows = await prisma.training_session.findMany({ where: { athlete_id: { in: [athleteA, athleteB] } } });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.date_debut.getTime() === newStart.getTime())).toBe(true);
    });
  });

  describe("cancel", () => {
    it("propage statut='annule' à la session ET à tous les training_session assignés (soft, aucune ligne supprimée)", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const athleteA = await makeAthlete();
      const sessionId = await repository.createSessionWithAssignments(coachId, fields(), athletesOf(athleteA), [], actorUserId);

      await repository.cancel(sessionId, actorUserId);

      const session = await prisma.coach_training_session.findUnique({ where: { id: sessionId } });
      const training = await prisma.training_session.findFirst({ where: { athlete_id: athleteA } });
      expect(session?.statut).toBe("annule");
      expect(training?.statut).toBe("annule");
      expect(training).not.toBeNull(); // soft : jamais supprimé
    });
  });

  describe("replaceAssignments", () => {
    it("retire les training_session des athlètes absents du nouvel ensemble, ajoute les nouveaux, conserve les communs", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const athleteA = await makeAthlete();
      const athleteB = await makeAthlete();
      const athleteC = await makeAthlete();
      const sessionId = await repository.createSessionWithAssignments(coachId, fields(), athletesOf(athleteA, athleteB), [], actorUserId);

      const before = await repository.findCurrentAssignments(sessionId);
      const bTrainingSessionId = before.find((a) => a.athlete_id === athleteB)!.training_session_id;

      // Nouvel ensemble : A (conservé), C (ajouté), B retiré.
      await repository.replaceAssignments(sessionId, fields(), athletesOf(athleteC), [bTrainingSessionId], [], actorUserId);

      const after = await repository.findCurrentAssignments(sessionId);
      expect(after.map((a) => a.athlete_id).sort()).toEqual([athleteA, athleteC].sort());
      expect(await prisma.training_session.findUnique({ where: { id: bTrainingSessionId } })).toBeNull();
    });

    it("idempotent : rejouer le même remplacement ne duplique rien", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const athleteA = await makeAthlete();
      const group = await prisma.coach_group.create({ data: { coach_id: coachId, name: `G ${runId}` } });
      const sessionId = await repository.createSessionWithAssignments(coachId, fields(), athletesOf(athleteA), [group.id], actorUserId);

      await repository.replaceAssignments(sessionId, fields(), [], [], [group.id], actorUserId);
      await repository.replaceAssignments(sessionId, fields(), [], [], [group.id], actorUserId);

      const assignments = await repository.findCurrentAssignments(sessionId);
      const groupSources = await prisma.coach_training_group_source.findMany({ where: { coach_training_session_id: sessionId } });
      expect(assignments).toHaveLength(1);
      expect(groupSources).toHaveLength(1);
    });

    it("remplace intégralement les group_sources (jamais un ajout cumulatif)", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const groupA = await prisma.coach_group.create({ data: { coach_id: coachId, name: `GA ${runId}` } });
      const groupB = await prisma.coach_group.create({ data: { coach_id: coachId, name: `GB ${runId}` } });
      const sessionId = await repository.createSessionWithAssignments(coachId, fields(), [], [groupA.id], actorUserId);

      await repository.replaceAssignments(sessionId, fields(), [], [], [groupB.id], actorUserId);

      const sources = await prisma.coach_training_group_source.findMany({ where: { coach_training_session_id: sessionId } });
      expect(sources.map((s) => s.group_id)).toEqual([groupB.id]);
    });
  });

  describe("suppression d'un groupe (ticket §21)", () => {
    it("supprime uniquement la provenance (group_source), jamais la session ni les assignments", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const athleteA = await makeAthlete();
      const group = await prisma.coach_group.create({ data: { coach_id: coachId, name: `G ${runId}` } });
      const sessionId = await repository.createSessionWithAssignments(coachId, fields(), athletesOf(athleteA), [group.id], actorUserId);

      await prisma.coach_group.delete({ where: { id: group.id } });

      const detail = await repository.findSessionDetail(sessionId);
      expect(detail).not.toBeNull();
      expect(detail?.assignments).toHaveLength(1);
      expect(detail?.group_sources).toEqual([]);
    });
  });

  describe("retrait coach_athlete (ticket §20)", () => {
    it("ne cascade jamais sur les training_session/assignments déjà créés", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const athleteA = await makeAthlete();
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteA } });
      const sessionId = await repository.createSessionWithAssignments(coachId, fields(), athletesOf(athleteA), [], actorUserId);

      await prisma.coach_athlete.delete({
        where: { coach_id_athlete_id: { coach_id: coachId, athlete_id: athleteA } },
      });

      const detail = await repository.findSessionDetail(sessionId);
      expect(detail?.assignments).toHaveLength(1);
      const training = await prisma.training_session.findFirst({ where: { athlete_id: athleteA } });
      expect(training).not.toBeNull();
    });
  });

  describe("séances récurrentes (series)", () => {
    const SERIES_NOTIFY = (actorUserId: string) => ({
      actorUserId,
      title: "Nouvel entraînement récurrent",
      message: "Ton coach t'a ajouté à la séance récurrente.",
    });

    function occurrences(...isoStarts: string[]): TrainingFieldsSnapshot[] {
      return isoStarts.map((iso) => fields({ date_debut: new Date(iso) }));
    }

    it("crée une séance complète par occurrence (même series_id), N×A training_session, group_sources par occurrence, UNE notification par athlète", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const athleteA = await makeAthlete();
      const athleteB = await makeAthlete();
      const group = await prisma.coach_group.create({ data: { coach_id: coachId, name: `Série ${runId}` } });
      const seriesId = randomUUID();

      const sessionIds = await repository.createSeriesWithAssignments(
        coachId,
        seriesId,
        occurrences("2026-10-07T18:00:00.000Z", "2026-10-14T18:00:00.000Z", "2026-10-21T18:00:00.000Z"),
        [
          { athleteId: athleteA, groupId: group.id },
          { athleteId: athleteB, groupId: null },
        ],
        [group.id],
        SERIES_NOTIFY(actorUserId),
      );

      expect(sessionIds).toHaveLength(3);
      const sessions = await prisma.coach_training_session.findMany({
        where: { id: { in: sessionIds } },
        orderBy: { date_debut: "asc" },
      });
      expect(sessions.map((x) => x.series_id)).toEqual([seriesId, seriesId, seriesId]);
      expect(sessions.every((x) => x.coach_id === coachId)).toBe(true);

      const assignments = await prisma.coach_training_assignment.findMany({
        where: { coach_training_session_id: { in: sessionIds } },
        include: { training_session: true },
      });
      expect(assignments).toHaveLength(6);
      // Chaque training_session porte la date de SON occurrence, jamais celle de la première.
      for (const a of assignments) {
        const session = sessions.find((x) => x.id === a.coach_training_session_id)!;
        expect(a.training_session.date_debut).toEqual(session.date_debut);
      }
      expect(assignments.filter((a) => a.athlete_id === athleteA).every((a) => a.group_id === group.id)).toBe(true);

      expect(
        await prisma.coach_training_group_source.count({ where: { coach_training_session_id: { in: sessionIds } } }),
      ).toBe(3);

      const notifications = await prisma.notification.findMany({
        where: { resource_id: { in: assignments.map((a) => a.training_session_id) } },
      });
      expect(notifications).toHaveLength(2);
      expect(notifications.every((n) => n.type === "TRAINING_ASSIGNED" && n.title === "Nouvel entraînement récurrent")).toBe(true);
      // Deep-link vers la séance de la PREMIÈRE occurrence de chaque athlète.
      const firstOccurrenceTrainingIds = assignments
        .filter((a) => a.coach_training_session_id === sessions[0].id)
        .map((a) => a.training_session_id)
        .sort();
      expect(notifications.map((n) => n.resource_id).sort()).toEqual(firstOccurrenceTrainingIds);
    });

    it("annuler la suite : seules les occurrences strictement futures et non annulées, séance coach ET training_session ; une notification par athlète ; idempotent", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const athleteA = await makeAthlete();
      const seriesId = randomUUID();
      const [past, alreadyCancelled, next, later] = await repository.createSeriesWithAssignments(
        coachId,
        seriesId,
        occurrences(
          "2026-10-07T18:00:00.000Z",
          "2026-10-14T18:00:00.000Z",
          "2026-10-21T18:00:00.000Z",
          "2026-10-28T19:00:00.000Z",
        ),
        [{ athleteId: athleteA, groupId: null }],
        [],
        SERIES_NOTIFY(actorUserId),
      );
      await repository.cancel(alreadyCancelled, actorUserId);
      const notificationsBefore = await prisma.notification.count({ where: { type: "TRAINING_CANCELLED", actor_user_id: actorUserId } });

      const result = await repository.cancelUpcomingInSeries(seriesId, new Date("2026-10-10T12:00:00.000Z"), actorUserId);

      expect(result).toEqual({ cancelledCount: 2 });
      const statusOf = async (id: string) => (await prisma.coach_training_session.findUnique({ where: { id } }))?.statut;
      expect(await statusOf(past)).toBe("prevu");
      expect(await statusOf(next)).toBe("annule");
      expect(await statusOf(later)).toBe("annule");
      const athleteTrainings = await prisma.coach_training_assignment.findMany({
        where: { coach_training_session_id: { in: [past, next, later] } },
        include: { training_session: { select: { statut: true, date_debut: true } } },
      });
      expect(athleteTrainings.find((a) => a.coach_training_session_id === past)?.training_session.statut).toBe("prevu");
      expect(athleteTrainings.find((a) => a.coach_training_session_id === next)?.training_session.statut).toBe("annule");

      const cancelNotifications = await prisma.notification.findMany({
        where: { type: "TRAINING_CANCELLED", actor_user_id: actorUserId },
        orderBy: { created_at: "desc" },
      });
      expect(cancelNotifications).toHaveLength(notificationsBefore + 1);
      expect(cancelNotifications[0].title).toBe("Entraînements annulés");
      expect(cancelNotifications[0].message).toContain("les 2 prochaines séances");
      expect(cancelNotifications[0].resource_id).toBe(
        athleteTrainings.find((a) => a.coach_training_session_id === next)?.training_session_id,
      );

      // Rejeu : rien à annuler, aucune nouvelle notification.
      expect(await repository.cancelUpcomingInSeries(seriesId, new Date("2026-10-10T12:00:00.000Z"), actorUserId)).toEqual({
        cancelledCount: 0,
      });
      expect(await prisma.notification.count({ where: { type: "TRAINING_CANCELLED", actor_user_id: actorUserId } })).toBe(
        notificationsBefore + 1,
      );
    });

    it("findSeriesOwnership : propriétaire d'une série existante, null pour une série inconnue", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const athleteA = await makeAthlete();
      const seriesId = randomUUID();
      await repository.createSeriesWithAssignments(
        coachId,
        seriesId,
        occurrences("2026-10-07T18:00:00.000Z"),
        [{ athleteId: athleteA, groupId: null }],
        [],
        SERIES_NOTIFY(actorUserId),
      );

      expect(await repository.findSeriesOwnership(seriesId)).toEqual({ coach_id: coachId });
      expect(await repository.findSeriesOwnership(randomUUID())).toBeNull();
    });
  });

  // La résolution/autorisation des destinataires (groupes/athlètes) est
  // désormais testée dans coach-destinataire-resolver.spec.ts, depuis que
  // cette logique a été extraite en composant partagé avec la publication
  // d'exercices (voir CoachDestinataireResolver).
});
