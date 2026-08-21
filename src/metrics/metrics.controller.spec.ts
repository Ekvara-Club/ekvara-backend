import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { MetricsController } from "./metrics.controller";
import { MetricsService } from "./metrics.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AthleteOwnershipGuard } from "../auth/athlete-ownership.guard";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

// Test au niveau HTTP (via supertest) pour exercer réellement ParseUUIDPipe et le
// ValidationPipe global, pas seulement des appels directs au service.
describe("MetricsController (HTTP)", () => {
  let app: INestApplication;
  let service: {
    createMeasurement: jest.Mock;
    findMeasurements: jest.Mock;
    getHighlights: jest.Mock;
    getOverview: jest.Mock;
  };

  const VALID_ATHLETE_ID = "240fe60f-6e74-46ea-87a0-45872bd1f4fe";
  const OTHER_ATHLETE_ID = "aaaaaaaa-1111-4111-8111-111111111111";
  const VALID_METRIC_TYPE_ID = "d1e1d1e1-1111-4111-8111-111111111111";

  let authCookie: string;
  let otherAthleteAuthCookie: string;

  beforeEach(async () => {
    service = {
      createMeasurement: jest.fn(),
      findMeasurements: jest.fn(),
      getHighlights: jest.fn(),
      getOverview: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [MetricsController],
      providers: [
        { provide: MetricsService, useValue: service },
        JwtAuthGuard,
        AthleteOwnershipGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    authCookie = authCookieHeader(
      signTestToken({ sub: "user-1", athleteId: VALID_ATHLETE_ID }),
    );
    otherAthleteAuthCookie = authCookieHeader(
      signTestToken({ sub: "user-2", athleteId: OTHER_ATHLETE_ID }),
    );
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST .../measurements sans authentification -> 401", async () => {
    await request(app.getHttpServer())
      .post(`/athletes/not-a-uuid/metrics/${VALID_METRIC_TYPE_ID}/measurements`)
      .send({ value: 90 })
      .expect(401);
    expect(service.createMeasurement).not.toHaveBeenCalled();
  });

  it("POST .../measurements avec le token d'un autre athlète -> 403", async () => {
    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/metrics/${VALID_METRIC_TYPE_ID}/measurements`)
      .set("Cookie", otherAthleteAuthCookie)
      .send({ value: 90 })
      .expect(403);
    expect(service.createMeasurement).not.toHaveBeenCalled();
  });

  it("POST .../measurements avec metricTypeId invalide (athlète authentifié) -> 400", async () => {
    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/metrics/not-a-uuid/measurements`)
      .set("Cookie", authCookie)
      .send({ value: 90 })
      .expect(400);
    expect(service.createMeasurement).not.toHaveBeenCalled();
  });

  it("POST .../measurements avec valeur non numérique -> 400", async () => {
    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/metrics/${VALID_METRIC_TYPE_ID}/measurements`)
      .set("Cookie", authCookie)
      .send({ value: "quatre-vingt-dix" })
      .expect(400);
    expect(service.createMeasurement).not.toHaveBeenCalled();
  });

  it("POST .../measurements valide -> 201", async () => {
    service.createMeasurement.mockResolvedValue({
      id: "meas-1",
      value: 90,
      measuredAt: new Date(),
      coachUserId: null,
      comment: "Test de force",
    });

    const res = await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/metrics/${VALID_METRIC_TYPE_ID}/measurements`)
      .set("Cookie", authCookie)
      .send({ value: 90, comment: "Test de force" })
      .expect(201);

    expect(res.body.id).toBe("meas-1");
  });

  it("GET .../measurements sans authentification -> 401", async () => {
    await request(app.getHttpServer())
      .get(`/athletes/not-a-uuid/metrics/${VALID_METRIC_TYPE_ID}/measurements`)
      .expect(401);
  });

  it("GET .../measurements valide -> 200", async () => {
    service.findMeasurements.mockResolvedValue([]);
    await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/metrics/${VALID_METRIC_TYPE_ID}/measurements`)
      .set("Cookie", authCookie)
      .expect(200);
  });

  it("GET .../progress/highlights sans authentification -> 401", async () => {
    await request(app.getHttpServer()).get("/athletes/not-a-uuid/progress/highlights").expect(401);
  });

  it("GET .../progress/highlights avec le token d'un autre athlète -> 403", async () => {
    await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/progress/highlights`)
      .set("Cookie", otherAthleteAuthCookie)
      .expect(403);
  });

  it("GET .../progress/highlights sans progression -> 200", async () => {
    service.getHighlights.mockResolvedValue({ improvedCount: 0, highlights: [] });

    const res = await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/progress/highlights`)
      .set("Cookie", authCookie)
      .expect(200);

    expect(res.body).toEqual({ improvedCount: 0, highlights: [] });
  });

  it("GET .../progress/highlights avec progressions -> 200", async () => {
    service.getHighlights.mockResolvedValue({
      improvedCount: 1,
      highlights: [
        {
          metricTypeId: VALID_METRIC_TYPE_ID,
          code: "vitesse",
          name: "Vitesse",
          unit: "points",
          direction: "higher",
          previousValue: 72,
          currentValue: 78,
          delta: 6,
          percentage: 8.33,
          status: "improved",
          previousMeasuredAt: new Date(),
          currentMeasuredAt: new Date(),
        },
      ],
    });

    const res = await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/progress/highlights`)
      .set("Cookie", authCookie)
      .expect(200);

    expect(res.body.improvedCount).toBe(1);
    expect(res.body.highlights[0].status).toBe("improved");
  });

  it("GET .../metrics/overview avec athleteId invalide -> 400", async () => {
    // AthleteOwnershipGuard s'exécute avant ParseUUIDPipe (cf. WeightsController) :
    // pour atteindre réellement le 400, le token doit porter le même athleteId
    // invalide que l'URL, sinon le guard rejette en 403 avant que le pipe ne
    // s'exécute.
    const invalidAthleteIdCookie = authCookieHeader(
      signTestToken({ sub: "user-1", athleteId: "not-a-uuid" }),
    );

    await request(app.getHttpServer())
      .get("/athletes/not-a-uuid/metrics/overview")
      .set("Cookie", invalidAthleteIdCookie)
      .expect(400);
    expect(service.getOverview).not.toHaveBeenCalled();
  });

  it("GET .../metrics/overview sans authentification -> 401", async () => {
    await request(app.getHttpServer()).get(`/athletes/${VALID_ATHLETE_ID}/metrics/overview`).expect(401);
    expect(service.getOverview).not.toHaveBeenCalled();
  });

  it("GET .../metrics/overview avec le token d'un autre athlète -> 403", async () => {
    await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/metrics/overview`)
      .set("Cookie", otherAthleteAuthCookie)
      .expect(403);
    expect(service.getOverview).not.toHaveBeenCalled();
  });

  it("GET .../metrics/overview valide -> 200, renvoie toutes les métriques (améliorées, en régression, inconnues)", async () => {
    service.getOverview.mockResolvedValue({
      metrics: [
        {
          id: "m1",
          code: "force",
          name: "Force",
          unit: "kg",
          direction: "higher",
          currentValue: 85,
          previousValue: 80,
          delta: 5,
          percentage: 6.25,
          status: "improved",
          measuredAt: new Date().toISOString(),
        },
        {
          id: "m2",
          code: "technique",
          name: "Technique",
          unit: "points",
          direction: "higher",
          currentValue: 55,
          previousValue: 60,
          delta: -5,
          percentage: -8.33,
          status: "regressed",
          measuredAt: new Date().toISOString(),
        },
        {
          id: "m3",
          code: "souplesse",
          name: "Souplesse",
          unit: "cm",
          direction: "higher",
          currentValue: null,
          previousValue: null,
          delta: null,
          percentage: null,
          status: "unknown",
          measuredAt: null,
        },
      ],
    });

    const res = await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/metrics/overview`)
      .set("Cookie", authCookie)
      .expect(200);

    expect(res.body.metrics.map((m: { code: string; status: string }) => [m.code, m.status])).toEqual([
      ["force", "improved"],
      ["technique", "regressed"],
      ["souplesse", "unknown"],
    ]);
  });
});
