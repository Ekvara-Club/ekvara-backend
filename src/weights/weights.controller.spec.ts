import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { WeightsController } from "./weights.controller";
import { WeightsService } from "./weights.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AthleteOwnershipGuard } from "../auth/athlete-ownership.guard";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

// Test au niveau HTTP (via supertest) pour exercer réellement ParseUUIDPipe et le
// ValidationPipe global (poids invalide), pas seulement des appels directs.
describe("WeightsController (HTTP)", () => {
  let app: INestApplication;
  let service: {
    createWeightLog: jest.Mock;
    findWeightLogsForAthlete: jest.Mock;
    createWeightTarget: jest.Mock;
    getWeightSummary: jest.Mock;
  };

  const VALID_ATHLETE_ID = "240fe60f-6e74-46ea-87a0-45872bd1f4fe";
  const OTHER_ATHLETE_ID = "aaaaaaaa-1111-4111-8111-111111111111";

  let authCookie: string;
  let otherAthleteAuthCookie: string;

  beforeEach(async () => {
    service = {
      createWeightLog: jest.fn(),
      findWeightLogsForAthlete: jest.fn(),
      createWeightTarget: jest.fn(),
      getWeightSummary: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [WeightsController],
      providers: [
        { provide: WeightsService, useValue: service },
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

  // Les guards (auth puis ownership) s'exécutent avant ParseUUIDPipe : une
  // requête sans cookie est rejetée en 401 avant même que le format de
  // l'UUID soit examiné.
  it("POST .../weights sans authentification -> 401", async () => {
    await request(app.getHttpServer())
      .post("/athletes/not-a-uuid/weights")
      .send({ weight: 74.5 })
      .expect(401);
    expect(service.createWeightLog).not.toHaveBeenCalled();
  });

  it("POST .../weights avec le token d'un autre athlète -> 403", async () => {
    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/weights`)
      .set("Cookie", otherAthleteAuthCookie)
      .send({ weight: 74.5 })
      .expect(403);
    expect(service.createWeightLog).not.toHaveBeenCalled();
  });

  it("POST .../weights avec un poids négatif -> 400", async () => {
    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/weights`)
      .set("Cookie", authCookie)
      .send({ weight: -5 })
      .expect(400);
    expect(service.createWeightLog).not.toHaveBeenCalled();
  });

  it("POST .../weights avec un poids à 0 -> 400 (strictement positif)", async () => {
    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/weights`)
      .set("Cookie", authCookie)
      .send({ weight: 0 })
      .expect(400);
  });

  it("POST .../weights valide (bon athlète authentifié) -> 201 et délègue au service", async () => {
    service.createWeightLog.mockResolvedValue({ id: "w-1", weight: 74.5, measuredAt: new Date(), note: null });

    const res = await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/weights`)
      .set("Cookie", authCookie)
      .send({ weight: 74.5, note: "Après le déjeuner" })
      .expect(201);

    expect(res.body.id).toBe("w-1");
    expect(service.createWeightLog).toHaveBeenCalledWith(
      VALID_ATHLETE_ID,
      expect.objectContaining({ weight: 74.5, note: "Après le déjeuner" }),
    );
  });

  it("GET .../weights sans authentification -> 401", async () => {
    await request(app.getHttpServer()).get("/athletes/not-a-uuid/weights").expect(401);
  });

  it("GET .../weights avec le token d'un autre athlète -> 403", async () => {
    await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/weights`)
      .set("Cookie", otherAthleteAuthCookie)
      .expect(403);
  });

  it("GET .../weights valide -> 200", async () => {
    service.findWeightLogsForAthlete.mockResolvedValue([]);
    await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/weights`)
      .set("Cookie", authCookie)
      .expect(200);
  });

  it("POST .../weight-targets avec un poids invalide -> 400", async () => {
    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/weight-targets`)
      .set("Cookie", authCookie)
      .send({ weight: -1 })
      .expect(400);
    expect(service.createWeightTarget).not.toHaveBeenCalled();
  });

  it("POST .../weight-targets avec un competitionId non-UUID -> 400", async () => {
    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/weight-targets`)
      .set("Cookie", authCookie)
      .send({ weight: 74.0, competitionId: "not-a-uuid" })
      .expect(400);
  });

  it("POST .../weight-targets valide -> 201", async () => {
    service.createWeightTarget.mockResolvedValue({
      id: "t-1",
      weight: 74.0,
      targetDate: null,
      competitionId: null,
      actif: true,
    });

    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/weight-targets`)
      .set("Cookie", authCookie)
      .send({ weight: 74.0 })
      .expect(201);
  });

  it("GET .../weight-summary sans authentification -> 401", async () => {
    await request(app.getHttpServer()).get("/athletes/not-a-uuid/weight-summary").expect(401);
  });

  it("GET .../weight-summary sans aucune donnée -> 200 (jamais 404)", async () => {
    service.getWeightSummary.mockResolvedValue({
      currentWeight: null,
      measuredAt: null,
      target: null,
      differenceToTarget: null,
      weeklyChange: null,
    });

    const res = await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/weight-summary`)
      .set("Cookie", authCookie)
      .expect(200);

    expect(res.body).toEqual({
      currentWeight: null,
      measuredAt: null,
      target: null,
      differenceToTarget: null,
      weeklyChange: null,
    });
  });
});
