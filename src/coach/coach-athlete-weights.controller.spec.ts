import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { CoachAthleteWeightsController } from "./coach-athlete-weights.controller";
import { WeightsService } from "../weights/weights.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

// Test HTTP : ce contrôleur n'a AUCUNE logique propre, uniquement le guard +
// la délégation à WeightsService (réel côté production, mocké ici comme
// toute dépendance externe à un test de contrôleur) — voir
// coach-athlete-weights.fixture.spec.ts pour la preuve end-to-end avec le
// vrai service.
describe("CoachAthleteWeightsController (HTTP)", () => {
  let app: INestApplication;
  let weightsService: { getWeightSummary: jest.Mock; createWeightTarget: jest.Mock };
  let prisma: { coach_athlete: { findUnique: jest.Mock } };
  let notificationsService: { notifyAthletes: jest.Mock };

  const COACH_ID = "c0ffee00-0000-4000-8000-000000000001";
  const ATHLETE_ID = "a1a1a1a1-0000-4000-8000-000000000001";

  let coachCookie: string;
  let athleteOnlyCookie: string;

  beforeEach(async () => {
    weightsService = { getWeightSummary: jest.fn(), createWeightTarget: jest.fn() };
    prisma = { coach_athlete: { findUnique: jest.fn() } };
    notificationsService = { notifyAthletes: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [CoachAthleteWeightsController],
      providers: [
        { provide: WeightsService, useValue: weightsService },
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

  describe("GET /coach/athletes/:athleteId/weight", () => {
    it("sans authentification -> 401", async () => {
      await request(app.getHttpServer()).get(`/coach/athletes/${ATHLETE_ID}/weight`).expect(401);
    });

    it("athlete-only -> 403", async () => {
      await request(app.getHttpServer())
        .get(`/coach/athletes/${ATHLETE_ID}/weight`)
        .set("Cookie", athleteOnlyCookie)
        .expect(403);
      expect(weightsService.getWeightSummary).not.toHaveBeenCalled();
    });

    it("athlete non assigné à ce coach -> 403, jamais WeightsService", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer()).get(`/coach/athletes/${ATHLETE_ID}/weight`).set("Cookie", coachCookie).expect(403);
      expect(weightsService.getWeightSummary).not.toHaveBeenCalled();
    });

    it("athlete assigné -> 200, délègue à WeightsService.getWeightSummary telle quelle", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      weightsService.getWeightSummary.mockResolvedValue({
        currentWeight: 74.5,
        measuredAt: new Date().toISOString(),
        target: null,
        differenceToTarget: null,
        weeklyChange: null,
      });

      const res = await request(app.getHttpServer())
        .get(`/coach/athletes/${ATHLETE_ID}/weight`)
        .set("Cookie", coachCookie)
        .expect(200);

      expect(res.body.currentWeight).toBe(74.5);
      expect(weightsService.getWeightSummary).toHaveBeenCalledWith(ATHLETE_ID);
    });
  });

  describe("POST /coach/athletes/:athleteId/weight-targets", () => {
    it("athlete non assigné -> 403", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        .post(`/coach/athletes/${ATHLETE_ID}/weight-targets`)
        .set("Cookie", coachCookie)
        .send({ weight: 74 })
        .expect(403);
      expect(weightsService.createWeightTarget).not.toHaveBeenCalled();
    });

    it("weight manquant -> 400 (même DTO/validation que l'athlète)", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      await request(app.getHttpServer())
        .post(`/coach/athletes/${ATHLETE_ID}/weight-targets`)
        .set("Cookie", coachCookie)
        .send({})
        .expect(400);
      expect(weightsService.createWeightTarget).not.toHaveBeenCalled();
    });

    it("athlete assigné -> 201, délègue au même DTO/service que l'athlète, notifie (premier objectif)", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      weightsService.getWeightSummary.mockResolvedValue({
        currentWeight: null,
        measuredAt: null,
        target: null,
        differenceToTarget: null,
        weeklyChange: null,
      });
      weightsService.createWeightTarget.mockResolvedValue({ id: "target-1", weight: 74, targetDate: null, competitionId: null, actif: true });

      const res = await request(app.getHttpServer())
        .post(`/coach/athletes/${ATHLETE_ID}/weight-targets`)
        .set("Cookie", coachCookie)
        .send({ weight: 74 })
        .expect(201);

      expect(res.body.id).toBe("target-1");
      expect(weightsService.createWeightTarget).toHaveBeenCalledWith(ATHLETE_ID, { weight: 74 });
      // Aucun objectif actif avant -> premier objectif = changement réel, notifié.
      expect(notificationsService.notifyAthletes).toHaveBeenCalledWith(
        [ATHLETE_ID],
        expect.objectContaining({ type: "WEIGHT_TARGET_UPDATED", actorUserId: "u-coach" }),
      );
    });

    it("mêmes valeurs que l'objectif actif -> pas de notification (idempotence)", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      weightsService.getWeightSummary.mockResolvedValue({
        currentWeight: 70,
        measuredAt: new Date().toISOString(),
        target: { weight: 74, targetDate: null, competitionId: null },
        differenceToTarget: -4,
        weeklyChange: null,
      });
      weightsService.createWeightTarget.mockResolvedValue({ id: "target-2", weight: 74, targetDate: null, competitionId: null, actif: true });

      await request(app.getHttpServer())
        .post(`/coach/athletes/${ATHLETE_ID}/weight-targets`)
        .set("Cookie", coachCookie)
        .send({ weight: 74 })
        .expect(201);

      expect(notificationsService.notifyAthletes).not.toHaveBeenCalled();
    });

    it("jamais de coachId accepté dans le body (whitelist)", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      await request(app.getHttpServer())
        .post(`/coach/athletes/${ATHLETE_ID}/weight-targets`)
        .set("Cookie", coachCookie)
        .send({ weight: 74, coachId: "autre-coach" })
        .expect(400);
      expect(weightsService.createWeightTarget).not.toHaveBeenCalled();
    });
  });
});
