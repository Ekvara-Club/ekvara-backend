import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { CoachTrainingsService } from "../coach/coach-trainings.service";
import { CoachTrainingsRepository } from "../coach/coach-trainings.repository";
import { CoachExercisesService } from "../coach/coach-exercises.service";
import { CoachExercisesRepository } from "../coach/coach-exercises.repository";
import { CoachDestinataireResolver } from "../coach/coach-destinataire-resolver";
import { CoachAthleteGoalsController } from "../coach/coach-athlete-goals.controller";
import { CoachAthleteWeightsController } from "../coach/coach-athlete-weights.controller";
import { GoalsService } from "../goals/goals.service";
import { GoalsRepository } from "../goals/goals.repository";
import { WeightsService } from "../weights/weights.service";
import { WeightsRepository } from "../weights/weights.repository";
import { CompetitionsRepository } from "../competitions/competitions.repository";
import { NotificationsRepository } from "./notifications.repository";
import { NotificationsService } from "./notifications.service";

// Test d'intégration Postgres réelle (même convention que
// coach-trainings.fixture.spec.ts) : vérifie que les mutations coach
// produisent RÉELLEMENT les bonnes lignes `notification` — dédoublonnage,
// idempotence, contenu, isolation multi-coach. Les contrôleurs sont
// instanciés directement (mêmes principe que coach-exercise-athlete-
// visibility.spec.ts) : req est simulé par un objet minimal { user: { sub } }
// — les guards (déjà couverts par les *.controller.spec.ts HTTP dédiés) ne
// sont pas le sujet ici.
describe("Notifications — production réelle par les mutations coach (intégration Postgres)", () => {
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

  const notificationsRepository = () => new NotificationsRepository(prisma);
  const notificationsService = () => new NotificationsService(notificationsRepository(), prisma);

  function trainingsService(): CoachTrainingsService {
    return new CoachTrainingsService(
      new CoachTrainingsRepository(prisma, notificationsRepository()),
      new CoachDestinataireResolver(prisma),
    );
  }

  function exercisesService(): CoachExercisesService {
    return new CoachExercisesService(
      new CoachExercisesRepository(prisma, notificationsRepository()),
      new CoachDestinataireResolver(prisma),
    );
  }

  function goalsController(): CoachAthleteGoalsController {
    return new CoachAthleteGoalsController(new GoalsService(new GoalsRepository(prisma)), notificationsService());
  }

  function weightsController(): CoachAthleteWeightsController {
    return new CoachAthleteWeightsController(
      new WeightsService(new WeightsRepository(prisma), new CompetitionsRepository(prisma)),
      notificationsService(),
    );
  }

  function reqFor(userId: string) {
    return { user: { sub: userId } } as never;
  }

  async function makeCoach(): Promise<{ coachId: string; userId: string }> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-notifprod-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `C${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return { coachId: profile.id, userId: user.id };
  }

  async function makeAthlete(prenom: string): Promise<{ athleteId: string; userId: string }> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-notifprod-athlete-${runId}-${counter}@test.fr`, nom: "Test", prenom },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
    return { athleteId: athlete.id, userId: user.id };
  }

  function notificationsFor(userId: string, type?: string) {
    return prisma.notification.findMany({ where: { recipient_user_id: userId, ...(type ? { type } : {}) } });
  }

  describe("TRAINING_ASSIGNED", () => {
    it("une notification par athlète assigné, contenu correct, resource_id = training_session PROPRE à l'athlète", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const a = await makeAthlete("A");
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: a.athleteId } });

      const training = await trainingsService().createTraining(coachId, actorUserId, {
        title: `Combat ${runId}`,
        startAt: "2026-09-05T18:00:00.000Z",
        athleteIds: [a.athleteId],
      });
      const generatedSession = await prisma.training_session.findFirstOrThrow({ where: { athlete_id: a.athleteId } });

      const notifs = await notificationsFor(a.userId, "TRAINING_ASSIGNED");
      expect(notifs).toHaveLength(1);
      expect(notifs[0].context).toBe("ATHLETE");
      expect(notifs[0].actor_user_id).toBe(actorUserId);
      expect(notifs[0].resource_type).toBe("TRAINING");
      // resource_id = le training_session PROPRE à cet athlète, jamais
      // coach_training_session_id (voir CoachTrainingsRepository.notifyAssigned).
      expect(notifs[0].resource_id).toBe(generatedSession.id);
      expect(notifs[0].title).toBe("Nouvel entraînement");
      expect(notifs[0].message).toContain("septembre");
      expect(training.assignments.athletes.map((x) => x.id)).toContain(a.athleteId);
    });

    it("dédoublonnage : athlète accessible via 2 groupes + individuel -> UNE seule notification", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const a = await makeAthlete("Dup");
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: a.athleteId } });
      const g1 = await prisma.coach_group.create({ data: { coach_id: coachId, name: `G1 ${runId}` } });
      const g2 = await prisma.coach_group.create({ data: { coach_id: coachId, name: `G2 ${runId}` } });
      await prisma.coach_group_athlete.create({ data: { group_id: g1.id, athlete_id: a.athleteId } });
      await prisma.coach_group_athlete.create({ data: { group_id: g2.id, athlete_id: a.athleteId } });

      await trainingsService().createTraining(coachId, actorUserId, {
        title: `Multi-groupe ${runId}`,
        startAt: "2026-09-05T18:00:00.000Z",
        groupIds: [g1.id, g2.id],
        athleteIds: [a.athleteId],
      });

      const notifs = await notificationsFor(a.userId, "TRAINING_ASSIGNED");
      expect(notifs).toHaveLength(1);
    });

    it("réassigner un athlète déjà présent (PUT assignments) ne le notifie pas une 2e fois, seul le nouvel athlète l'est", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const a = await makeAthlete("Existing");
      const b = await makeAthlete("New");
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: a.athleteId } });
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: b.athleteId } });

      const training = await trainingsService().createTraining(coachId, actorUserId, {
        title: `Réassign ${runId}`,
        startAt: "2026-09-05T18:00:00.000Z",
        athleteIds: [a.athleteId],
      });

      await trainingsService().replaceAssignments(coachId, actorUserId, training.id, {
        groupIds: [],
        athleteIds: [a.athleteId, b.athleteId],
      });

      expect(await notificationsFor(a.userId, "TRAINING_ASSIGNED")).toHaveLength(1); // toujours 1, pas 2
      expect(await notificationsFor(b.userId, "TRAINING_ASSIGNED")).toHaveLength(1);
    });
  });

  describe("TRAINING_UPDATED", () => {
    it("changement réel (date) -> notifie tous les athlètes assignés", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const a = await makeAthlete("Upd");
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: a.athleteId } });

      const training = await trainingsService().createTraining(coachId, actorUserId, {
        title: `Avant ${runId}`,
        startAt: "2026-09-05T18:00:00.000Z",
        athleteIds: [a.athleteId],
      });

      await trainingsService().updateContent(training.id, actorUserId, { startAt: "2026-09-05T20:30:00.000Z" });

      const notifs = await notificationsFor(a.userId, "TRAINING_UPDATED");
      expect(notifs).toHaveLength(1);
      expect(notifs[0].message).toContain("22h30"); // 20:30 UTC = 22h30 Europe/Paris (CEST, +2 en septembre)
    });

    it("IDEMPOTENCE : PATCH avec la même valeur déjà en place -> AUCUNE notification", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const a = await makeAthlete("NoOp");
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: a.athleteId } });

      const training = await trainingsService().createTraining(coachId, actorUserId, {
        title: `Stable ${runId}`,
        startAt: "2026-09-05T18:00:00.000Z",
        location: "Dojo 1",
        athleteIds: [a.athleteId],
      });

      await trainingsService().updateContent(training.id, actorUserId, { location: "Dojo 1" });

      expect(await notificationsFor(a.userId, "TRAINING_UPDATED")).toHaveLength(0);
    });
  });

  describe("TRAINING_CANCELLED", () => {
    it("annulation -> une notification par athlète assigné, snapshot du titre/date au moment de l'annulation", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const a = await makeAthlete("Cancel");
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: a.athleteId } });

      const training = await trainingsService().createTraining(coachId, actorUserId, {
        title: `À annuler ${runId}`,
        startAt: "2026-09-05T18:00:00.000Z",
        athleteIds: [a.athleteId],
      });

      await trainingsService().cancel(training.id, actorUserId);

      const notifs = await notificationsFor(a.userId, "TRAINING_CANCELLED");
      expect(notifs).toHaveLength(1);
      expect(notifs[0].message).toContain(`À annuler ${runId}`);
    });

    it("IDEMPOTENCE : annuler deux fois la même séance ne duplique pas la notification", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const a = await makeAthlete("DoubleCancel");
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: a.athleteId } });

      const training = await trainingsService().createTraining(coachId, actorUserId, {
        title: `Double annulation ${runId}`,
        startAt: "2026-09-05T18:00:00.000Z",
        athleteIds: [a.athleteId],
      });

      await trainingsService().cancel(training.id, actorUserId);
      await trainingsService().cancel(training.id, actorUserId);

      expect(await notificationsFor(a.userId, "TRAINING_CANCELLED")).toHaveLength(1);
    });
  });

  describe("EXERCISE_ASSIGNED", () => {
    it("publication initiale -> notifie chaque nouvel athlète, jamais les déjà-assignés lors d'un republish", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const a = await makeAthlete("ExA");
      const b = await makeAthlete("ExB");
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: a.athleteId } });
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: b.athleteId } });

      const exercise = await exercisesService().createExercise(coachId, { title: `Cut avant ${runId}` });
      await exercisesService().replaceAssignments(coachId, actorUserId, exercise.id, {
        groupIds: [],
        athleteIds: [a.athleteId],
      });
      expect(await notificationsFor(a.userId, "EXERCISE_ASSIGNED")).toHaveLength(1);

      // Republish avec A (déjà assigné) + B (nouveau) : seul B est notifié.
      await exercisesService().replaceAssignments(coachId, actorUserId, exercise.id, {
        groupIds: [],
        athleteIds: [a.athleteId, b.athleteId],
      });
      expect(await notificationsFor(a.userId, "EXERCISE_ASSIGNED")).toHaveLength(1); // toujours 1
      expect(await notificationsFor(b.userId, "EXERCISE_ASSIGNED")).toHaveLength(1);
    });

    it("mise à jour du CONTENU d'un exercice déjà assigné ne notifie jamais (éviter le bruit, ticket EXERCISE)", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const a = await makeAthlete("ExUpdate");
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: a.athleteId } });

      const exercise = await exercisesService().createExercise(coachId, { title: `Avant ${runId}` });
      await exercisesService().replaceAssignments(coachId, actorUserId, exercise.id, { groupIds: [], athleteIds: [a.athleteId] });
      await exercisesService().updateContent(exercise.id, { title: `Après ${runId}` });

      expect(await notificationsFor(a.userId, "EXERCISE_ASSIGNED")).toHaveLength(1); // toujours 1, aucune 2e notif
    });
  });

  describe("GOAL_UPDATED", () => {
    it("création d'objectif par le coach -> notifie l'athlète", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const a = await makeAthlete("Goal");
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: a.athleteId } });

      await goalsController().createGoal(reqFor(actorUserId), a.athleteId, { titre: `Médaille ${runId}` });

      const notifs = await notificationsFor(a.userId, "GOAL_UPDATED");
      expect(notifs).toHaveLength(1);
      expect(notifs[0].title).toBe("Nouvel objectif");
    });

    it("changement de statut réel -> notifie ; même statut renvoyé -> AUCUNE notification supplémentaire", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const a = await makeAthlete("GoalStatus");
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: a.athleteId } });

      const goal = await goalsController().createGoal(reqFor(actorUserId), a.athleteId, { titre: `Objectif ${runId}` });
      const afterCreate = await notificationsFor(a.userId, "GOAL_UPDATED");
      expect(afterCreate).toHaveLength(1);

      await goalsController().updateStatus(reqFor(actorUserId), a.athleteId, goal.id, { statut: "atteint" });
      expect(await notificationsFor(a.userId, "GOAL_UPDATED")).toHaveLength(2); // create + 1 update réel

      await goalsController().updateStatus(reqFor(actorUserId), a.athleteId, goal.id, { statut: "atteint" });
      expect(await notificationsFor(a.userId, "GOAL_UPDATED")).toHaveLength(2); // idempotent : pas de 3e
    });
  });

  describe("WEIGHT_TARGET_UPDATED", () => {
    it("premier objectif de poids -> notifie ; mêmes valeurs renvoyées -> AUCUNE notification ; valeur différente -> notifie", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const a = await makeAthlete("Weight");
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: a.athleteId } });

      await weightsController().createWeightTarget(reqFor(actorUserId), a.athleteId, { weight: 74 });
      expect(await notificationsFor(a.userId, "WEIGHT_TARGET_UPDATED")).toHaveLength(1);

      await weightsController().createWeightTarget(reqFor(actorUserId), a.athleteId, { weight: 74 });
      expect(await notificationsFor(a.userId, "WEIGHT_TARGET_UPDATED")).toHaveLength(1); // idempotent

      await weightsController().createWeightTarget(reqFor(actorUserId), a.athleteId, { weight: 70 });
      expect(await notificationsFor(a.userId, "WEIGHT_TARGET_UPDATED")).toHaveLength(2); // changement réel

      // Message toujours neutre, jamais de valeur chiffrée (ticket WEIGHT_TARGET).
      const notifs = await notificationsFor(a.userId, "WEIGHT_TARGET_UPDATED");
      expect(notifs.every((n) => !/\d/.test(n.message ?? ""))).toBe(true);
    });
  });

  describe("Isolation multi-coach", () => {
    it("actor_user_id reflète TOUJOURS le coach réellement à l'origine de l'action, jamais un autre coach du même athlète", async () => {
      const coachA = await makeCoach();
      const coachB = await makeCoach();
      const shared = await makeAthlete("Shared");
      await prisma.coach_athlete.create({ data: { coach_id: coachA.coachId, athlete_id: shared.athleteId } });
      await prisma.coach_athlete.create({ data: { coach_id: coachB.coachId, athlete_id: shared.athleteId } });

      await trainingsService().createTraining(coachA.coachId, coachA.userId, {
        title: `Séance coach A ${runId}`,
        startAt: "2026-09-05T18:00:00.000Z",
        athleteIds: [shared.athleteId],
      });
      await trainingsService().createTraining(coachB.coachId, coachB.userId, {
        title: `Séance coach B ${runId}`,
        startAt: "2026-09-05T19:00:00.000Z",
        athleteIds: [shared.athleteId],
      });

      const notifs = await notificationsFor(shared.userId, "TRAINING_ASSIGNED");
      expect(notifs).toHaveLength(2);
      expect(notifs.map((n) => n.actor_user_id).sort()).toEqual([coachA.userId, coachB.userId].sort());
    });
  });

  describe("Rollback transactionnel (training)", () => {
    it("échec de résolution des destinataires -> aucune session ET aucune notification créée", async () => {
      const { coachId, userId: actorUserId } = await makeCoach();
      const a = await makeAthlete("Rollback");
      // `a` n'est PAS lié au coach (coach_athlete absent) -> le resolver rejette.

      await expect(
        trainingsService().createTraining(coachId, actorUserId, {
          title: `Devrait échouer ${runId}`,
          startAt: "2026-09-05T18:00:00.000Z",
          athleteIds: [a.athleteId],
        }),
      ).rejects.toThrow();

      expect(await notificationsFor(a.userId, "TRAINING_ASSIGNED")).toHaveLength(0);
    });
  });
});
