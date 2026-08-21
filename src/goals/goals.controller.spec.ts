import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, NotFoundException, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { GoalsController } from "./goals.controller";
import { GoalsService } from "./goals.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AthleteOwnershipGuard } from "../auth/athlete-ownership.guard";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

// Test au niveau HTTP (via supertest) pour exercer réellement ParseUUIDPipe et le
// ValidationPipe global, pas seulement des appels directs au service.
describe("GoalsController (HTTP)", () => {
  let app: INestApplication;
  let service: {
    createGoal: jest.Mock;
    findAllForAthlete: jest.Mock;
    findActiveForAthlete: jest.Mock;
    addStep: jest.Mock;
    updateStep: jest.Mock;
    updateStatus: jest.Mock;
  };

  const VALID_ATHLETE_ID = "240fe60f-6e74-46ea-87a0-45872bd1f4fe";
  const OTHER_ATHLETE_ID = "aaaaaaaa-1111-4111-8111-111111111111";
  const VALID_GOAL_ID = "b2e6d6b0-2a34-4f77-9e2e-2a2b2b2b2b2b";
  const VALID_STEP_ID = "c3f7e7c1-3b45-4a88-8e3f-3c3c3c3c3c3c";

  let authCookie: string;
  let otherAthleteAuthCookie: string;

  beforeEach(async () => {
    service = {
      createGoal: jest.fn(),
      findAllForAthlete: jest.fn(),
      findActiveForAthlete: jest.fn(),
      addStep: jest.fn(),
      updateStep: jest.fn(),
      updateStatus: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [GoalsController],
      providers: [
        { provide: GoalsService, useValue: service },
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

  // Les guards s'exécutent avant ParseUUIDPipe : sans cookie, une requête est
  // rejetée en 401 avant même l'examen du format de l'UUID.
  it("POST .../goals sans authentification -> 401", async () => {
    await request(app.getHttpServer())
      .post("/athletes/not-a-uuid/goals")
      .send({ titre: "Objectif" })
      .expect(401);
    expect(service.createGoal).not.toHaveBeenCalled();
  });

  it("POST .../goals avec le token d'un autre athlète -> 403", async () => {
    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/goals`)
      .set("Cookie", otherAthleteAuthCookie)
      .send({ titre: "Objectif" })
      .expect(403);
    expect(service.createGoal).not.toHaveBeenCalled();
  });

  it("POST .../goals sans titre -> 400", async () => {
    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/goals`)
      .set("Cookie", authCookie)
      .send({ type: "long_terme" })
      .expect(400);
    expect(service.createGoal).not.toHaveBeenCalled();
  });

  it("POST .../goals valide (authentifié) -> 201", async () => {
    service.createGoal.mockResolvedValue({
      id: VALID_GOAL_ID,
      type: "long_terme",
      titre: "Podium au championnat de France",
      description: null,
      dateCible: new Date("2027-03-28"),
      statut: "en_cours",
      progress: { completed: 0, total: 0, percentage: null },
      steps: [],
    });

    const res = await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/goals`)
      .set("Cookie", authCookie)
      .send({ type: "long_terme", titre: "Podium au championnat de France", dateCible: "2027-03-28" })
      .expect(201);

    expect(res.body.id).toBe(VALID_GOAL_ID);
  });

  it("GET .../goals sans authentification -> 401", async () => {
    await request(app.getHttpServer()).get("/athletes/not-a-uuid/goals").expect(401);
  });

  it("GET .../goals avec le token d'un autre athlète -> 403", async () => {
    await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/goals`)
      .set("Cookie", otherAthleteAuthCookie)
      .expect(403);
  });

  it("GET .../goals valide -> 200", async () => {
    service.findAllForAthlete.mockResolvedValue([]);
    await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/goals`)
      .set("Cookie", authCookie)
      .expect(200);
  });

  it("GET .../goals/active sans authentification -> 401", async () => {
    await request(app.getHttpServer()).get("/athletes/not-a-uuid/goals/active").expect(401);
  });

  it("GET .../goals/active sans objectif actif -> 200 null", async () => {
    service.findActiveForAthlete.mockResolvedValue(null);

    const res = await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/goals/active`)
      .set("Cookie", authCookie)
      .expect(200);

    expect(res.body).toBeNull();
  });

  it("POST .../goals/:goalId/steps avec goalId invalide (athlète authentifié) -> 400", async () => {
    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/goals/not-a-uuid/steps`)
      .set("Cookie", authCookie)
      .send({ titre: "Top 8" })
      .expect(400);
    expect(service.addStep).not.toHaveBeenCalled();
  });

  it("POST .../goals/:goalId/steps valide -> 201", async () => {
    service.addStep.mockResolvedValue({ id: VALID_STEP_ID, titre: "Top 8", ordre: 0, completed: false });

    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/goals/${VALID_GOAL_ID}/steps`)
      .set("Cookie", authCookie)
      .send({ titre: "Top 8", ordre: 0 })
      .expect(201);
  });

  it("PATCH .../steps/:stepId sans champ completed -> 400", async () => {
    await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/goals/${VALID_GOAL_ID}/steps/${VALID_STEP_ID}`)
      .set("Cookie", authCookie)
      .send({})
      .expect(400);
    expect(service.updateStep).not.toHaveBeenCalled();
  });

  it("PATCH .../steps/:stepId valide -> 200", async () => {
    service.updateStep.mockResolvedValue({
      id: VALID_STEP_ID,
      titre: "Top 8",
      ordre: 0,
      completed: true,
    });

    const res = await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/goals/${VALID_GOAL_ID}/steps/${VALID_STEP_ID}`)
      .set("Cookie", authCookie)
      .send({ completed: true })
      .expect(200);

    expect(res.body.completed).toBe(true);
  });

  it("PATCH .../goals/:goalId sans authentification -> 401", async () => {
    await request(app.getHttpServer())
      .patch(`/athletes/not-a-uuid/goals/${VALID_GOAL_ID}`)
      .send({ statut: "atteint" })
      .expect(401);
    expect(service.updateStatus).not.toHaveBeenCalled();
  });

  it("PATCH .../goals/:goalId avec le token d'un autre athlète -> 403", async () => {
    await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/goals/${VALID_GOAL_ID}`)
      .set("Cookie", otherAthleteAuthCookie)
      .send({ statut: "atteint" })
      .expect(403);
    expect(service.updateStatus).not.toHaveBeenCalled();
  });

  it("PATCH .../goals/:goalId avec goalId invalide (athlète authentifié) -> 400", async () => {
    await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/goals/not-a-uuid`)
      .set("Cookie", authCookie)
      .send({ statut: "atteint" })
      .expect(400);
    expect(service.updateStatus).not.toHaveBeenCalled();
  });

  it("PATCH .../goals/:goalId avec statut invalide -> 400", async () => {
    await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/goals/${VALID_GOAL_ID}`)
      .set("Cookie", authCookie)
      .send({ statut: "termine" })
      .expect(400);
    expect(service.updateStatus).not.toHaveBeenCalled();
  });

  it("PATCH .../goals/:goalId sans statut -> 400", async () => {
    await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/goals/${VALID_GOAL_ID}`)
      .set("Cookie", authCookie)
      .send({})
      .expect(400);
    expect(service.updateStatus).not.toHaveBeenCalled();
  });

  it("PATCH .../goals/:goalId objectif inexistant (ou d'un autre athlète) -> 404", async () => {
    service.updateStatus.mockRejectedValue(new NotFoundException("Objectif introuvable pour cet athlète"));

    await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/goals/${VALID_GOAL_ID}`)
      .set("Cookie", authCookie)
      .send({ statut: "atteint" })
      .expect(404);
  });

  it.each(["en_cours", "atteint", "abandonne"])(
    "PATCH .../goals/:goalId avec statut '%s' -> 200, renvoie la vue objectif complète",
    async (statut) => {
      service.updateStatus.mockResolvedValue({
        id: VALID_GOAL_ID,
        type: "long_terme",
        titre: "Podium au championnat de France",
        description: null,
        dateCible: new Date("2027-03-28"),
        statut,
        progress: { completed: 1, total: 2, percentage: 50 },
        steps: [{ id: VALID_STEP_ID, titre: "Top 8", ordre: 0, completed: true }],
      });

      const res = await request(app.getHttpServer())
        .patch(`/athletes/${VALID_ATHLETE_ID}/goals/${VALID_GOAL_ID}`)
        .set("Cookie", authCookie)
        .send({ statut })
        .expect(200);

      expect(res.body.statut).toBe(statut);
      expect(res.body.progress).toEqual({ completed: 1, total: 2, percentage: 50 });
      expect(res.body.steps).toHaveLength(1);
      expect(service.updateStatus).toHaveBeenCalledWith(VALID_ATHLETE_ID, VALID_GOAL_ID, { statut });
    },
  );
});
