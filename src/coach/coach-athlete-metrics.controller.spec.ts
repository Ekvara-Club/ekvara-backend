import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { CoachAthleteMetricsController } from "./coach-athlete-metrics.controller";
import { MetricsService } from "../metrics/metrics.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { PrismaService } from "../prisma/prisma.service";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

describe("CoachAthleteMetricsController (HTTP)", () => {
  let app: INestApplication;
  let metricsService: { getOverview: jest.Mock; findMeasurements: jest.Mock; createMeasurement: jest.Mock };
  let prisma: { coach_athlete: { findUnique: jest.Mock } };

  const COACH_SUB = "u-coach-0000-0000-0000-000000000001";
  const COACH_ID = "c0ffee00-0000-4000-8000-000000000001";
  const ATHLETE_ID = "a1a1a1a1-0000-4000-8000-000000000001";
  const METRIC_TYPE_ID = "5555bbbb-0000-4000-8000-000000000001";

  let coachCookie: string;
  let athleteOnlyCookie: string;

  beforeEach(async () => {
    metricsService = { getOverview: jest.fn(), findMeasurements: jest.fn(), createMeasurement: jest.fn() };
    prisma = { coach_athlete: { findUnique: jest.fn() } };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [CoachAthleteMetricsController],
      providers: [
        { provide: MetricsService, useValue: metricsService },
        { provide: PrismaService, useValue: prisma },
        JwtAuthGuard,
        CoachAthleteAccessGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();

    coachCookie = authCookieHeader(signTestToken({ sub: COACH_SUB, coachId: COACH_ID }));
    athleteOnlyCookie = authCookieHeader(signTestToken({ sub: "u-athlete", athleteId: "a-anything" }));
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /coach/athletes/:athleteId/metrics/overview", () => {
    it("sans authentification -> 401", async () => {
      await request(app.getHttpServer()).get(`/coach/athletes/${ATHLETE_ID}/metrics/overview`).expect(401);
    });

    it("athlete-only -> 403", async () => {
      await request(app.getHttpServer())
        .get(`/coach/athletes/${ATHLETE_ID}/metrics/overview`)
        .set("Cookie", athleteOnlyCookie)
        .expect(403);
      expect(metricsService.getOverview).not.toHaveBeenCalled();
    });

    it("athlete non assigné -> 403, jamais MetricsService", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        .get(`/coach/athletes/${ATHLETE_ID}/metrics/overview`)
        .set("Cookie", coachCookie)
        .expect(403);
      expect(metricsService.getOverview).not.toHaveBeenCalled();
    });

    it("athlete assigné -> 200, délègue à MetricsService.getOverview telle quelle", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      metricsService.getOverview.mockResolvedValue({ metrics: [] });

      const res = await request(app.getHttpServer())
        .get(`/coach/athletes/${ATHLETE_ID}/metrics/overview`)
        .set("Cookie", coachCookie)
        .expect(200);

      expect(res.body).toEqual({ metrics: [] });
      expect(metricsService.getOverview).toHaveBeenCalledWith(ATHLETE_ID);
    });
  });

  describe("GET /coach/athletes/:athleteId/metrics/:metricTypeId/measurements", () => {
    it("athlete non assigné -> 403", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        .get(`/coach/athletes/${ATHLETE_ID}/metrics/${METRIC_TYPE_ID}/measurements`)
        .set("Cookie", coachCookie)
        .expect(403);
    });

    it("UUID metricTypeId invalide -> 403 (le guard rejette avant ParseUUIDPipe si athleteId est valide, sinon la pipe rejette en 400 — testé ici sur athleteId valide)", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      await request(app.getHttpServer())
        .get(`/coach/athletes/${ATHLETE_ID}/metrics/pas-un-uuid/measurements`)
        .set("Cookie", coachCookie)
        .expect(400);
      expect(metricsService.findMeasurements).not.toHaveBeenCalled();
    });

    it("athlete assigné -> 200", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      metricsService.findMeasurements.mockResolvedValue([]);

      const res = await request(app.getHttpServer())
        .get(`/coach/athletes/${ATHLETE_ID}/metrics/${METRIC_TYPE_ID}/measurements`)
        .set("Cookie", coachCookie)
        .expect(200);

      expect(res.body).toEqual([]);
      expect(metricsService.findMeasurements).toHaveBeenCalledWith(ATHLETE_ID, METRIC_TYPE_ID);
    });
  });

  describe("POST /coach/athletes/:athleteId/metrics/:metricTypeId/measurements", () => {
    it("athlete non assigné -> 403", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        .post(`/coach/athletes/${ATHLETE_ID}/metrics/${METRIC_TYPE_ID}/measurements`)
        .set("Cookie", coachCookie)
        .send({ value: 380 })
        .expect(403);
      expect(metricsService.createMeasurement).not.toHaveBeenCalled();
    });

    it("value manquant -> 400", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      await request(app.getHttpServer())
        .post(`/coach/athletes/${ATHLETE_ID}/metrics/${METRIC_TYPE_ID}/measurements`)
        .set("Cookie", coachCookie)
        .send({})
        .expect(400);
      expect(metricsService.createMeasurement).not.toHaveBeenCalled();
    });

    it("aucun champ unit accepté (le DTO n'en a pas) : un champ 'unit' dans le body -> 400 (whitelist)", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      await request(app.getHttpServer())
        .post(`/coach/athletes/${ATHLETE_ID}/metrics/${METRIC_TYPE_ID}/measurements`)
        .set("Cookie", coachCookie)
        .send({ value: 380, unit: "kg" })
        .expect(400);
      expect(metricsService.createMeasurement).not.toHaveBeenCalled();
    });

    it("SÉCURITÉ CRITIQUE (ticket §9/§21) : un coachUserId spoofé dans le body est TOUJOURS ignoré, remplacé par req.user.sub", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      metricsService.createMeasurement.mockResolvedValue({ id: "m-1", value: 380, coachUserId: COACH_SUB, comment: null, measuredAt: new Date() });

      const spoofedId = "ffffffff-0000-4000-8000-000000000000";
      await request(app.getHttpServer())
        .post(`/coach/athletes/${ATHLETE_ID}/metrics/${METRIC_TYPE_ID}/measurements`)
        .set("Cookie", coachCookie)
        .send({ value: 380, coachUserId: spoofedId })
        .expect(201);

      const [, , dto] = metricsService.createMeasurement.mock.calls[0];
      expect(dto.coachUserId).toBe(COACH_SUB);
      expect(dto.coachUserId).not.toBe(spoofedId);
    });

    it("athlete assigné, sans coachUserId fourni -> 201, coachUserId forcé depuis le token quand même", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      metricsService.createMeasurement.mockResolvedValue({ id: "m-1", value: 380, coachUserId: COACH_SUB, comment: null, measuredAt: new Date() });

      await request(app.getHttpServer())
        .post(`/coach/athletes/${ATHLETE_ID}/metrics/${METRIC_TYPE_ID}/measurements`)
        .set("Cookie", coachCookie)
        .send({ value: 380 })
        .expect(201);

      expect(metricsService.createMeasurement).toHaveBeenCalledWith(
        ATHLETE_ID,
        METRIC_TYPE_ID,
        expect.objectContaining({ value: 380, coachUserId: COACH_SUB }),
      );
    });
  });
});
