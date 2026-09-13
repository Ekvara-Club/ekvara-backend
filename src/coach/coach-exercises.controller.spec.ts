import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { CoachExercisesController } from "./coach-exercises.controller";
import { CoachExercisesService } from "./coach-exercises.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGuard } from "../auth/coach.guard";
import { CoachExerciseOwnershipGuard } from "../auth/coach-exercise-ownership.guard";
import { PrismaService } from "../prisma/prisma.service";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

describe("CoachExercisesController (HTTP)", () => {
  let app: INestApplication;
  let service: {
    createExercise: jest.Mock;
    findLibraryForCoach: jest.Mock;
    findOneForCoach: jest.Mock;
    updateContent: jest.Mock;
    replaceAssignments: jest.Mock;
    deleteExercise: jest.Mock;
  };
  let prisma: { exercise: { findUnique: jest.Mock } };

  const COACH_ID = "c0ffee00-0000-4000-8000-000000000001";
  const OTHER_COACH_ID = "c0ffee00-0000-4000-8000-000000000009";
  const EXERCISE_ID = "eeee1111-0000-4000-8000-000000000001";
  const ATHLETE_ID = "a1a1a1a1-0000-4000-8000-000000000001";

  let coachCookie: string;
  let athleteOnlyCookie: string;

  beforeEach(async () => {
    service = {
      createExercise: jest.fn(),
      findLibraryForCoach: jest.fn(),
      findOneForCoach: jest.fn(),
      updateContent: jest.fn(),
      replaceAssignments: jest.fn(),
      deleteExercise: jest.fn(),
    };
    prisma = { exercise: { findUnique: jest.fn() } };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [CoachExercisesController],
      providers: [
        { provide: CoachExercisesService, useValue: service },
        { provide: PrismaService, useValue: prisma },
        JwtAuthGuard,
        CoachGuard,
        CoachExerciseOwnershipGuard,
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

  describe("POST /coach/exercises", () => {
    it("sans authentification -> 401", async () => {
      await request(app.getHttpServer()).post("/coach/exercises").send({ title: "Cut avant" }).expect(401);
    });

    it("athlete-only -> 403", async () => {
      await request(app.getHttpServer())
        .post("/coach/exercises")
        .set("Cookie", athleteOnlyCookie)
        .send({ title: "Cut avant" })
        .expect(403);
      expect(service.createExercise).not.toHaveBeenCalled();
    });

    it("title vide -> 400", async () => {
      await request(app.getHttpServer())
        .post("/coach/exercises")
        .set("Cookie", coachCookie)
        .send({ title: "" })
        .expect(400);
      expect(service.createExercise).not.toHaveBeenCalled();
    });

    it("videoUrl invalide -> 400", async () => {
      await request(app.getHttpServer())
        .post("/coach/exercises")
        .set("Cookie", coachCookie)
        .send({ title: "Cut avant", videoUrl: "pas-une-url" })
        .expect(400);
    });

    it("un coachId envoyé dans le body est rejeté (whitelist), jamais accepté (ticket §7)", async () => {
      await request(app.getHttpServer())
        .post("/coach/exercises")
        .set("Cookie", coachCookie)
        .send({ title: "Cut avant", coachId: OTHER_COACH_ID })
        .expect(400); // forbidNonWhitelisted : coachId n'est pas un champ du DTO
      expect(service.createExercise).not.toHaveBeenCalled();
    });

    it("coach valide -> 201", async () => {
      service.createExercise.mockResolvedValue({ id: EXERCISE_ID, title: "Cut avant" });

      const res = await request(app.getHttpServer())
        .post("/coach/exercises")
        .set("Cookie", coachCookie)
        .send({ title: "Cut avant" })
        .expect(201);

      expect(res.body.id).toBe(EXERCISE_ID);
      expect(service.createExercise).toHaveBeenCalledWith(COACH_ID, expect.objectContaining({ title: "Cut avant" }));
    });
  });

  describe("GET /coach/exercises", () => {
    it("athlete-only -> 403", async () => {
      await request(app.getHttpServer()).get("/coach/exercises").set("Cookie", athleteOnlyCookie).expect(403);
    });

    it("coach sans exercice -> 200 []", async () => {
      service.findLibraryForCoach.mockResolvedValue([]);
      const res = await request(app.getHttpServer()).get("/coach/exercises").set("Cookie", coachCookie).expect(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("GET /coach/exercises/:exerciseId (CoachExerciseOwnershipGuard)", () => {
    it("exercice inconnu -> 403 (jamais 404)", async () => {
      prisma.exercise.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        .get(`/coach/exercises/${EXERCISE_ID}`)
        .set("Cookie", coachCookie)
        .expect(403);
      expect(service.findOneForCoach).not.toHaveBeenCalled();
    });

    it("exercice global (created_by_coach_id null) -> 403, non modifiable par un coach", async () => {
      prisma.exercise.findUnique.mockResolvedValue({ created_by_coach_id: null });
      await request(app.getHttpServer())
        .get(`/coach/exercises/${EXERCISE_ID}`)
        .set("Cookie", coachCookie)
        .expect(403);
    });

    it("exercice d'un autre coach -> 403", async () => {
      prisma.exercise.findUnique.mockResolvedValue({ created_by_coach_id: OTHER_COACH_ID });
      await request(app.getHttpServer())
        .get(`/coach/exercises/${EXERCISE_ID}`)
        .set("Cookie", coachCookie)
        .expect(403);
    });

    it("exercice du coach connecté -> 200", async () => {
      prisma.exercise.findUnique.mockResolvedValue({ created_by_coach_id: COACH_ID });
      service.findOneForCoach.mockResolvedValue({ id: EXERCISE_ID });

      const res = await request(app.getHttpServer())
        .get(`/coach/exercises/${EXERCISE_ID}`)
        .set("Cookie", coachCookie)
        .expect(200);
      expect(res.body.id).toBe(EXERCISE_ID);
    });
  });

  describe("PATCH /coach/exercises/:exerciseId", () => {
    it("exercice d'un autre coach -> 403, jamais le service", async () => {
      prisma.exercise.findUnique.mockResolvedValue({ created_by_coach_id: OTHER_COACH_ID });
      await request(app.getHttpServer())
        .patch(`/coach/exercises/${EXERCISE_ID}`)
        .set("Cookie", coachCookie)
        .send({ title: "Nouveau" })
        .expect(403);
      expect(service.updateContent).not.toHaveBeenCalled();
    });

    it("coach propriétaire -> 200", async () => {
      prisma.exercise.findUnique.mockResolvedValue({ created_by_coach_id: COACH_ID });
      service.updateContent.mockResolvedValue({ id: EXERCISE_ID, title: "Nouveau" });

      await request(app.getHttpServer())
        .patch(`/coach/exercises/${EXERCISE_ID}`)
        .set("Cookie", coachCookie)
        .send({ title: "Nouveau" })
        .expect(200);
      expect(service.updateContent).toHaveBeenCalledWith(EXERCISE_ID, { title: "Nouveau" });
    });
  });

  describe("PUT /coach/exercises/:exerciseId/assignments", () => {
    it("exercice d'un autre coach -> 403", async () => {
      prisma.exercise.findUnique.mockResolvedValue({ created_by_coach_id: OTHER_COACH_ID });
      await request(app.getHttpServer())
        .put(`/coach/exercises/${EXERCISE_ID}/assignments`)
        .set("Cookie", coachCookie)
        .send({ groupIds: [], athleteIds: [ATHLETE_ID] })
        .expect(403);
      expect(service.replaceAssignments).not.toHaveBeenCalled();
    });

    it("coach propriétaire -> 200, coachId vient du JWT", async () => {
      prisma.exercise.findUnique.mockResolvedValue({ created_by_coach_id: COACH_ID });
      service.replaceAssignments.mockResolvedValue({ id: EXERCISE_ID });

      await request(app.getHttpServer())
        .put(`/coach/exercises/${EXERCISE_ID}/assignments`)
        .set("Cookie", coachCookie)
        .send({ groupIds: [], athleteIds: [ATHLETE_ID] })
        .expect(200);

      expect(service.replaceAssignments).toHaveBeenCalledWith(COACH_ID, "u-coach", EXERCISE_ID, {
        groupIds: [],
        athleteIds: [ATHLETE_ID],
      });
    });
  });

  describe("DELETE /coach/exercises/:exerciseId (suppression physique)", () => {
    it("exercice d'un autre coach -> 403", async () => {
      prisma.exercise.findUnique.mockResolvedValue({ created_by_coach_id: OTHER_COACH_ID });
      await request(app.getHttpServer()).delete(`/coach/exercises/${EXERCISE_ID}`).set("Cookie", coachCookie).expect(403);
      expect(service.deleteExercise).not.toHaveBeenCalled();
    });

    it("coach propriétaire -> 204", async () => {
      prisma.exercise.findUnique.mockResolvedValue({ created_by_coach_id: COACH_ID });
      service.deleteExercise.mockResolvedValue(undefined);

      await request(app.getHttpServer()).delete(`/coach/exercises/${EXERCISE_ID}`).set("Cookie", coachCookie).expect(204);
      expect(service.deleteExercise).toHaveBeenCalledWith(EXERCISE_ID);
    });
  });
});
