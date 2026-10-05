import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { CoachTrainingsController } from "./coach-trainings.controller";
import { CoachTrainingsService } from "./coach-trainings.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGuard } from "../auth/coach.guard";
import { CoachTrainingOwnershipGuard } from "../auth/coach-training-ownership.guard";
import { PrismaService } from "../prisma/prisma.service";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

describe("CoachTrainingsController (HTTP)", () => {
  let app: INestApplication;
  let service: {
    createTraining: jest.Mock;
    findAllForCoach: jest.Mock;
    findOneForCoach: jest.Mock;
    updateContent: jest.Mock;
    replaceAssignments: jest.Mock;
    cancel: jest.Mock;
    createSeries: jest.Mock;
    cancelUpcomingInSeries: jest.Mock;
  };
  let prisma: { coach_training_session: { findUnique: jest.Mock } };

  const COACH_ID = "c0ffee00-0000-4000-8000-000000000001";
  const OTHER_COACH_ID = "c0ffee00-0000-4000-8000-000000000009";
  const TRAINING_ID = "aaaa1111-0000-4000-8000-000000000001";
  const ATHLETE_ID = "a1a1a1a1-0000-4000-8000-000000000001";

  let coachCookie: string;
  let athleteOnlyCookie: string;

  beforeEach(async () => {
    service = {
      createTraining: jest.fn(),
      findAllForCoach: jest.fn(),
      findOneForCoach: jest.fn(),
      updateContent: jest.fn(),
      replaceAssignments: jest.fn(),
      cancel: jest.fn(),
      createSeries: jest.fn(),
      cancelUpcomingInSeries: jest.fn(),
    };
    prisma = { coach_training_session: { findUnique: jest.fn() } };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [CoachTrainingsController],
      providers: [
        { provide: CoachTrainingsService, useValue: service },
        { provide: PrismaService, useValue: prisma },
        JwtAuthGuard,
        CoachGuard,
        CoachTrainingOwnershipGuard,
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

  describe("POST /coach/trainings", () => {
    it("sans authentification -> 401", async () => {
      await request(app.getHttpServer())
        .post("/coach/trainings")
        .send({ title: "Combat", startAt: "2026-09-05T18:00:00.000Z", athleteIds: [ATHLETE_ID] })
        .expect(401);
    });

    it("athlete-only -> 403", async () => {
      await request(app.getHttpServer())
        .post("/coach/trainings")
        .set("Cookie", athleteOnlyCookie)
        .send({ title: "Combat", startAt: "2026-09-05T18:00:00.000Z", athleteIds: [ATHLETE_ID] })
        .expect(403);
      expect(service.createTraining).not.toHaveBeenCalled();
    });

    it("title vide -> 400", async () => {
      await request(app.getHttpServer())
        .post("/coach/trainings")
        .set("Cookie", coachCookie)
        .send({ title: "", startAt: "2026-09-05T18:00:00.000Z", athleteIds: [ATHLETE_ID] })
        .expect(400);
      expect(service.createTraining).not.toHaveBeenCalled();
    });

    it("startAt invalide -> 400", async () => {
      await request(app.getHttpServer())
        .post("/coach/trainings")
        .set("Cookie", coachCookie)
        .send({ title: "Combat", startAt: "pas-une-date", athleteIds: [ATHLETE_ID] })
        .expect(400);
    });

    it("UUID invalide dans athleteIds -> 400", async () => {
      await request(app.getHttpServer())
        .post("/coach/trainings")
        .set("Cookie", coachCookie)
        .send({ title: "Combat", startAt: "2026-09-05T18:00:00.000Z", athleteIds: ["pas-un-uuid"] })
        .expect(400);
    });

    it("coach valide -> 201", async () => {
      service.createTraining.mockResolvedValue({ id: TRAINING_ID, title: "Combat" });

      const res = await request(app.getHttpServer())
        .post("/coach/trainings")
        .set("Cookie", coachCookie)
        .send({ title: "Combat", startAt: "2026-09-05T18:00:00.000Z", athleteIds: [ATHLETE_ID] })
        .expect(201);

      expect(res.body.id).toBe(TRAINING_ID);
      expect(service.createTraining).toHaveBeenCalledWith(COACH_ID, "u-coach", expect.objectContaining({ title: "Combat" }));
    });
  });

  describe("POST /coach/trainings/series", () => {
    const VALID = {
      title: "Combat",
      startDate: "2026-10-07",
      startTime: "20:00",
      endTime: "21:30",
      weekdays: [3],
      durationMonths: 3,
      athleteIds: [ATHLETE_ID],
    };

    it("athlete-only -> 403", async () => {
      await request(app.getHttpServer()).post("/coach/trainings/series").set("Cookie", athleteOnlyCookie).send(VALID).expect(403);
      expect(service.createSeries).not.toHaveBeenCalled();
    });

    it.each([
      ["durée hors 1/3/6/12 mois", { durationMonths: 2 }],
      ["aucun jour", { weekdays: [] }],
      ["jour hors 1..7", { weekdays: [8] }],
      ["jour en double", { weekdays: [3, 3] }],
      ["date de départ non YYYY-MM-DD", { startDate: "07/10/2026" }],
      ["heure non HH:mm", { startTime: "20h" }],
    ])("%s -> 400", async (_label, override) => {
      await request(app.getHttpServer())
        .post("/coach/trainings/series")
        .set("Cookie", coachCookie)
        .send({ ...VALID, ...override })
        .expect(400);
      expect(service.createSeries).not.toHaveBeenCalled();
    });

    it("coach valide -> 201, coach issu du JWT", async () => {
      service.createSeries.mockResolvedValue({ seriesId: "s-1", occurrenceCount: 13 });

      const res = await request(app.getHttpServer()).post("/coach/trainings/series").set("Cookie", coachCookie).send(VALID).expect(201);

      expect(res.body).toEqual({ seriesId: "s-1", occurrenceCount: 13 });
      expect(service.createSeries).toHaveBeenCalledWith(COACH_ID, "u-coach", expect.objectContaining({ weekdays: [3], durationMonths: 3 }));
    });
  });

  describe("DELETE /coach/trainings/series/:seriesId/upcoming", () => {
    const SERIES_ID = "5e5e5e5e-0000-4000-8000-000000000001";

    it("athlete-only -> 403", async () => {
      await request(app.getHttpServer())
        .delete(`/coach/trainings/series/${SERIES_ID}/upcoming`)
        .set("Cookie", athleteOnlyCookie)
        .expect(403);
      expect(service.cancelUpcomingInSeries).not.toHaveBeenCalled();
    });

    it("seriesId non UUID -> 400", async () => {
      await request(app.getHttpServer())
        .delete("/coach/trainings/series/pas-un-uuid/upcoming")
        .set("Cookie", coachCookie)
        .expect(400);
    });

    it("coach -> 200 avec le nombre de séances annulées", async () => {
      service.cancelUpcomingInSeries.mockResolvedValue({ cancelledCount: 4 });

      const res = await request(app.getHttpServer())
        .delete(`/coach/trainings/series/${SERIES_ID}/upcoming`)
        .set("Cookie", coachCookie)
        .expect(200);

      expect(res.body).toEqual({ cancelledCount: 4 });
      expect(service.cancelUpcomingInSeries).toHaveBeenCalledWith(COACH_ID, "u-coach", SERIES_ID);
    });
  });

  describe("GET /coach/trainings", () => {
    it("athlete-only -> 403", async () => {
      await request(app.getHttpServer()).get("/coach/trainings").set("Cookie", athleteOnlyCookie).expect(403);
    });

    it("coach sans séance -> 200 []", async () => {
      service.findAllForCoach.mockResolvedValue([]);
      const res = await request(app.getHttpServer()).get("/coach/trainings").set("Cookie", coachCookie).expect(200);
      expect(res.body).toEqual([]);
    });

    it("from sans to -> 400", async () => {
      await request(app.getHttpServer())
        .get("/coach/trainings?from=2026-09-01")
        .set("Cookie", coachCookie)
        .expect(400);
    });

    it("un éventuel ?coachId= dans l'URL est ignoré : le service reçoit toujours le coachId du JWT, jamais celui du client", async () => {
      service.findAllForCoach.mockResolvedValue([]);

      await request(app.getHttpServer())
        .get(`/coach/trainings?coachId=${OTHER_COACH_ID}`)
        .set("Cookie", coachCookie)
        .expect(200);

      expect(service.findAllForCoach).toHaveBeenCalledWith(COACH_ID, undefined);
    });
  });

  describe("GET /coach/trainings/:trainingId (CoachTrainingOwnershipGuard)", () => {
    it("séance inconnue -> 403 (jamais 404)", async () => {
      prisma.coach_training_session.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        .get(`/coach/trainings/${TRAINING_ID}`)
        .set("Cookie", coachCookie)
        .expect(403);
      expect(service.findOneForCoach).not.toHaveBeenCalled();
    });

    it("séance d'un autre coach -> 403", async () => {
      prisma.coach_training_session.findUnique.mockResolvedValue({ coach_id: OTHER_COACH_ID });
      await request(app.getHttpServer())
        .get(`/coach/trainings/${TRAINING_ID}`)
        .set("Cookie", coachCookie)
        .expect(403);
    });

    it("séance du coach connecté -> 200", async () => {
      prisma.coach_training_session.findUnique.mockResolvedValue({ coach_id: COACH_ID });
      service.findOneForCoach.mockResolvedValue({ id: TRAINING_ID });

      const res = await request(app.getHttpServer())
        .get(`/coach/trainings/${TRAINING_ID}`)
        .set("Cookie", coachCookie)
        .expect(200);
      expect(res.body.id).toBe(TRAINING_ID);
    });
  });

  describe("PATCH /coach/trainings/:trainingId", () => {
    it("séance d'un autre coach -> 403, jamais le service", async () => {
      prisma.coach_training_session.findUnique.mockResolvedValue({ coach_id: OTHER_COACH_ID });
      await request(app.getHttpServer())
        .patch(`/coach/trainings/${TRAINING_ID}`)
        .set("Cookie", coachCookie)
        .send({ title: "Nouveau titre" })
        .expect(403);
      expect(service.updateContent).not.toHaveBeenCalled();
    });

    it("coach propriétaire -> 200", async () => {
      prisma.coach_training_session.findUnique.mockResolvedValue({ coach_id: COACH_ID });
      service.updateContent.mockResolvedValue({ id: TRAINING_ID, title: "Nouveau titre" });

      await request(app.getHttpServer())
        .patch(`/coach/trainings/${TRAINING_ID}`)
        .set("Cookie", coachCookie)
        .send({ title: "Nouveau titre" })
        .expect(200);
      expect(service.updateContent).toHaveBeenCalledWith(TRAINING_ID, "u-coach", { title: "Nouveau titre" });
    });
  });

  describe("PUT /coach/trainings/:trainingId/assignments", () => {
    it("séance d'un autre coach -> 403", async () => {
      prisma.coach_training_session.findUnique.mockResolvedValue({ coach_id: OTHER_COACH_ID });
      await request(app.getHttpServer())
        .put(`/coach/trainings/${TRAINING_ID}/assignments`)
        .set("Cookie", coachCookie)
        .send({ groupIds: [], athleteIds: [ATHLETE_ID] })
        .expect(403);
      expect(service.replaceAssignments).not.toHaveBeenCalled();
    });

    it("coach propriétaire -> 200, délègue avec coachId du JWT", async () => {
      prisma.coach_training_session.findUnique.mockResolvedValue({ coach_id: COACH_ID });
      service.replaceAssignments.mockResolvedValue({ id: TRAINING_ID });

      await request(app.getHttpServer())
        .put(`/coach/trainings/${TRAINING_ID}/assignments`)
        .set("Cookie", coachCookie)
        .send({ groupIds: [], athleteIds: [ATHLETE_ID] })
        .expect(200);

      expect(service.replaceAssignments).toHaveBeenCalledWith(COACH_ID, "u-coach", TRAINING_ID, { groupIds: [], athleteIds: [ATHLETE_ID] });
    });
  });

  describe("DELETE /coach/trainings/:trainingId (annulation douce)", () => {
    it("séance d'un autre coach -> 403", async () => {
      prisma.coach_training_session.findUnique.mockResolvedValue({ coach_id: OTHER_COACH_ID });
      await request(app.getHttpServer()).delete(`/coach/trainings/${TRAINING_ID}`).set("Cookie", coachCookie).expect(403);
      expect(service.cancel).not.toHaveBeenCalled();
    });

    it("coach propriétaire -> 200, renvoie la séance annulée (pas 204 : ce n'est pas une suppression physique)", async () => {
      prisma.coach_training_session.findUnique.mockResolvedValue({ coach_id: COACH_ID });
      service.cancel.mockResolvedValue({ id: TRAINING_ID, status: "annule" });

      const res = await request(app.getHttpServer())
        .delete(`/coach/trainings/${TRAINING_ID}`)
        .set("Cookie", coachCookie)
        .expect(200);
      expect(res.body.status).toBe("annule");
    });
  });
});
