import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, NotFoundException, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { CoachAthleteGoalsController } from "./coach-athlete-goals.controller";
import { GoalsService } from "../goals/goals.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

describe("CoachAthleteGoalsController (HTTP)", () => {
  let app: INestApplication;
  let goalsService: {
    createGoal: jest.Mock;
    findAllForAthlete: jest.Mock;
    updateStatus: jest.Mock;
    addStep: jest.Mock;
    updateStep: jest.Mock;
  };
  let prisma: { coach_athlete: { findUnique: jest.Mock } };
  let notificationsService: { notifyAthletes: jest.Mock };

  const COACH_ID = "c0ffee00-0000-4000-8000-000000000001";
  const ATHLETE_ID = "a1a1a1a1-0000-4000-8000-000000000001";
  const GOAL_ID = "9999aaaa-0000-4000-8000-000000000001";
  const STEP_ID = "8888aaaa-0000-4000-8000-000000000001";

  let coachCookie: string;
  let athleteOnlyCookie: string;

  beforeEach(async () => {
    goalsService = {
      createGoal: jest.fn(),
      // Défaut [] (aucun objectif existant) : suffisant pour les tests qui
      // n'exercent pas le diff de notification sur updateStatus (voir
      // CoachAthleteGoalsController.updateStatus, qui appelle
      // findAllForAthlete pour comparer le statut avant/après).
      findAllForAthlete: jest.fn().mockResolvedValue([]),
      updateStatus: jest.fn(),
      addStep: jest.fn(),
      updateStep: jest.fn(),
    };
    prisma = { coach_athlete: { findUnique: jest.fn() } };
    notificationsService = { notifyAthletes: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [CoachAthleteGoalsController],
      providers: [
        { provide: GoalsService, useValue: goalsService },
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notificationsService },
        JwtAuthGuard,
        CoachAthleteAccessGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();

    coachCookie = authCookieHeader(signTestToken({ sub: "u-coach", coachId: COACH_ID }));
    athleteOnlyCookie = authCookieHeader(signTestToken({ sub: "u-athlete", athleteId: "a-anything" }));
  });

  afterEach(async () => {
    await app.close();
  });

  describe("POST /coach/athletes/:athleteId/goals", () => {
    it("athlete-only -> 403", async () => {
      await request(app.getHttpServer())
        .post(`/coach/athletes/${ATHLETE_ID}/goals`)
        .set("Cookie", athleteOnlyCookie)
        .send({ titre: "Médaille régionale" })
        .expect(403);
      expect(goalsService.createGoal).not.toHaveBeenCalled();
    });

    it("athlete non assigné -> 403", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        .post(`/coach/athletes/${ATHLETE_ID}/goals`)
        .set("Cookie", coachCookie)
        .send({ titre: "Médaille régionale" })
        .expect(403);
    });

    it("titre vide -> 400", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      await request(app.getHttpServer())
        .post(`/coach/athletes/${ATHLETE_ID}/goals`)
        .set("Cookie", coachCookie)
        .send({ titre: "" })
        .expect(400);
      expect(goalsService.createGoal).not.toHaveBeenCalled();
    });

    it("athlete assigné -> 201, même DTO que l'athlète, notifie l'athlète (GOAL_UPDATED)", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      goalsService.createGoal.mockResolvedValue({ id: GOAL_ID, titre: "Médaille régionale" });

      const res = await request(app.getHttpServer())
        .post(`/coach/athletes/${ATHLETE_ID}/goals`)
        .set("Cookie", coachCookie)
        .send({ titre: "Médaille régionale" })
        .expect(201);

      expect(res.body.id).toBe(GOAL_ID);
      expect(goalsService.createGoal).toHaveBeenCalledWith(ATHLETE_ID, { titre: "Médaille régionale" });
      expect(notificationsService.notifyAthletes).toHaveBeenCalledWith(
        [ATHLETE_ID],
        expect.objectContaining({ type: "GOAL_UPDATED", actorUserId: "u-coach", resourceId: GOAL_ID }),
      );
    });
  });

  describe("GET /coach/athletes/:athleteId/goals", () => {
    it("athlete non assigné -> 403", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer()).get(`/coach/athletes/${ATHLETE_ID}/goals`).set("Cookie", coachCookie).expect(403);
    });

    it("athlete sans objectif -> 200 []", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      goalsService.findAllForAthlete.mockResolvedValue([]);
      const res = await request(app.getHttpServer()).get(`/coach/athletes/${ATHLETE_ID}/goals`).set("Cookie", coachCookie).expect(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("PATCH /coach/athletes/:athleteId/goals/:goalId", () => {
    it("statut invalide (hors en_cours/atteint/abandonne) -> 400", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      await request(app.getHttpServer())
        .patch(`/coach/athletes/${ATHLETE_ID}/goals/${GOAL_ID}`)
        .set("Cookie", coachCookie)
        .send({ statut: "nouveau-statut-invente" })
        .expect(400);
      expect(goalsService.updateStatus).not.toHaveBeenCalled();
    });

    it("goal appartenant à un autre athlète (ownership interne GoalsService) -> propage l'erreur du service (404)", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      goalsService.updateStatus.mockRejectedValue(new NotFoundException(`Objectif ${GOAL_ID} introuvable pour cet athlète`));

      await request(app.getHttpServer())
        .patch(`/coach/athletes/${ATHLETE_ID}/goals/${GOAL_ID}`)
        .set("Cookie", coachCookie)
        .send({ statut: "atteint" })
        .expect(404);
    });

    it("mise à jour valide, statut réellement différent -> 200, notifie l'athlète", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      goalsService.findAllForAthlete.mockResolvedValue([{ id: GOAL_ID, titre: "Médaille régionale", statut: "en_cours" }]);
      goalsService.updateStatus.mockResolvedValue({ id: GOAL_ID, titre: "Médaille régionale", statut: "atteint" });

      const res = await request(app.getHttpServer())
        .patch(`/coach/athletes/${ATHLETE_ID}/goals/${GOAL_ID}`)
        .set("Cookie", coachCookie)
        .send({ statut: "atteint" })
        .expect(200);

      expect(res.body.statut).toBe("atteint");
      expect(goalsService.updateStatus).toHaveBeenCalledWith(ATHLETE_ID, GOAL_ID, { statut: "atteint" });
      expect(notificationsService.notifyAthletes).toHaveBeenCalledWith(
        [ATHLETE_ID],
        expect.objectContaining({ type: "GOAL_UPDATED", actorUserId: "u-coach", resourceId: GOAL_ID }),
      );
    });

    it("statut renvoyé identique à l'actuel -> 200, AUCUNE notification (idempotence)", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      goalsService.findAllForAthlete.mockResolvedValue([{ id: GOAL_ID, titre: "Médaille régionale", statut: "atteint" }]);
      goalsService.updateStatus.mockResolvedValue({ id: GOAL_ID, titre: "Médaille régionale", statut: "atteint" });

      await request(app.getHttpServer())
        .patch(`/coach/athletes/${ATHLETE_ID}/goals/${GOAL_ID}`)
        .set("Cookie", coachCookie)
        .send({ statut: "atteint" })
        .expect(200);

      expect(notificationsService.notifyAthletes).not.toHaveBeenCalled();
    });
  });

  describe("POST /coach/athletes/:athleteId/goals/:goalId/steps", () => {
    it("athlete assigné -> 201", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      goalsService.addStep.mockResolvedValue({ id: STEP_ID, titre: "Étape 1", completed: false });

      await request(app.getHttpServer())
        .post(`/coach/athletes/${ATHLETE_ID}/goals/${GOAL_ID}/steps`)
        .set("Cookie", coachCookie)
        .send({ titre: "Étape 1" })
        .expect(201);

      expect(goalsService.addStep).toHaveBeenCalledWith(ATHLETE_ID, GOAL_ID, { titre: "Étape 1" });
    });
  });

  describe("PATCH /coach/athletes/:athleteId/goals/:goalId/steps/:stepId", () => {
    it("completed manquant -> 400", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      await request(app.getHttpServer())
        .patch(`/coach/athletes/${ATHLETE_ID}/goals/${GOAL_ID}/steps/${STEP_ID}`)
        .set("Cookie", coachCookie)
        .send({})
        .expect(400);
      expect(goalsService.updateStep).not.toHaveBeenCalled();
    });

    it("toggle valide -> 200, completed_at géré par le service (pas recalculé ici)", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      goalsService.updateStep.mockResolvedValue({ id: STEP_ID, titre: "Étape 1", completed: true });

      await request(app.getHttpServer())
        .patch(`/coach/athletes/${ATHLETE_ID}/goals/${GOAL_ID}/steps/${STEP_ID}`)
        .set("Cookie", coachCookie)
        .send({ completed: true })
        .expect(200);

      expect(goalsService.updateStep).toHaveBeenCalledWith(ATHLETE_ID, GOAL_ID, STEP_ID, { completed: true });
    });
  });

  describe("cross-athlete / cross-goal (ticket §15)", () => {
    it("goal d'un autre athlète via l'URL de l'athlète autorisé -> 404 propagé par GoalsService (jamais un faux succès)", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" }); // athleteId de l'URL EST autorisé
      goalsService.updateStatus.mockRejectedValue(new NotFoundException("introuvable pour cet athlète"));

      await request(app.getHttpServer())
        .patch(`/coach/athletes/${ATHLETE_ID}/goals/${GOAL_ID}`)
        .set("Cookie", coachCookie)
        .send({ statut: "atteint" })
        .expect(404);
    });
  });
});
