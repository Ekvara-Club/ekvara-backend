import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, NotFoundException } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { ExercisesController } from "./exercises.controller";
import { ExercisesService } from "./exercises.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

// Test au niveau HTTP (via supertest) pour exercer réellement JwtAuthGuard et
// ParseUUIDPipe, pas seulement des appels directs au service.
describe("ExercisesController (HTTP)", () => {
  let app: INestApplication;
  let service: {
    findAll: jest.Mock;
    findOne: jest.Mock;
  };

  const ATHLETE_ID = "240fe60f-6e74-46ea-87a0-45872bd1f4fe";
  const EXERCISE_ID = "b2e6d6b0-2a34-4f77-9e2e-2a2b2b2b2b2b";

  const exercise = (overrides: Partial<{ titre: string }> = {}) => ({
    id: EXERCISE_ID,
    titre: "Travail du cut en déplacement",
    type_exercice: "technique",
    panel_technique: "cut",
    niveau: "intermediaire",
    description: "Description",
    video_url: null,
    gratuit: true,
    ...overrides,
  });

  let authCookie: string;

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      findOne: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [ExercisesController],
      providers: [{ provide: ExercisesService, useValue: service }, JwtAuthGuard],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    authCookie = authCookieHeader(signTestToken({ sub: "user-1", athleteId: ATHLETE_ID }));
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /exercises sans authentification -> 401", async () => {
    await request(app.getHttpServer()).get("/exercises").expect(401);
    expect(service.findAll).not.toHaveBeenCalled();
  });

  it("GET /exercises avec authentification -> 200 et liste des exercices", async () => {
    service.findAll.mockResolvedValue([exercise()]);

    const response = await request(app.getHttpServer())
      .get("/exercises")
      .set("Cookie", authCookie)
      .expect(200);

    expect(response.body).toEqual([exercise()]);
  });

  it("GET /exercises avec authentification -> 200 et liste vide quand la table est vide", async () => {
    service.findAll.mockResolvedValue([]);

    const response = await request(app.getHttpServer())
      .get("/exercises")
      .set("Cookie", authCookie)
      .expect(200);

    expect(response.body).toEqual([]);
  });

  it("GET /exercises/:id sans authentification -> 401", async () => {
    await request(app.getHttpServer()).get(`/exercises/${EXERCISE_ID}`).expect(401);
    expect(service.findOne).not.toHaveBeenCalled();
  });

  it("GET /exercises/:id avec authentification -> 200 et l'exercice", async () => {
    service.findOne.mockResolvedValue(exercise());

    const response = await request(app.getHttpServer())
      .get(`/exercises/${EXERCISE_ID}`)
      .set("Cookie", authCookie)
      .expect(200);

    expect(response.body).toEqual(exercise());
    expect(service.findOne).toHaveBeenCalledWith(EXERCISE_ID);
  });

  it("GET /exercises/:id avec UUID invalide (authentifié) -> 400", async () => {
    await request(app.getHttpServer())
      .get("/exercises/not-a-uuid")
      .set("Cookie", authCookie)
      .expect(400);
    expect(service.findOne).not.toHaveBeenCalled();
  });

  it("GET /exercises/:id inconnu (authentifié) -> 404", async () => {
    service.findOne.mockRejectedValue(new NotFoundException(`Exercice ${EXERCISE_ID} introuvable`));

    await request(app.getHttpServer())
      .get(`/exercises/${EXERCISE_ID}`)
      .set("Cookie", authCookie)
      .expect(404);
  });

  it("aucun cookie/token n'est jamais reflété dans les réponses de la liste ou de la fiche", async () => {
    service.findAll.mockResolvedValue([exercise()]);
    service.findOne.mockResolvedValue(exercise());

    const listResponse = await request(app.getHttpServer())
      .get("/exercises")
      .set("Cookie", authCookie)
      .expect(200);
    const detailResponse = await request(app.getHttpServer())
      .get(`/exercises/${EXERCISE_ID}`)
      .set("Cookie", authCookie)
      .expect(200);

    expect(JSON.stringify(listResponse.body)).not.toMatch(/token|password|cookie/i);
    expect(JSON.stringify(detailResponse.body)).not.toMatch(/token|password|cookie/i);
  });
});
