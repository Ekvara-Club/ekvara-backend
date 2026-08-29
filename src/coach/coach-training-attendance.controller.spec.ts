import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { CoachTrainingAttendanceController } from "./coach-training-attendance.controller";
import { CoachTrainingAttendanceService } from "./coach-training-attendance.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachTrainingOwnershipGuard } from "../auth/coach-training-ownership.guard";
import { PrismaService } from "../prisma/prisma.service";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

// Même conventions que CoachTrainingsController (HTTP) : PrismaService mocké
// uniquement pour la résolution de CoachTrainingOwnershipGuard (coach_id de
// la séance), service métier mocké — ce fichier ne teste QUE le contrat
// HTTP (401/403/400/200), pas la logique métier (voir coach-training-attendance.spec.ts,
// intégration Postgres réelle, pour ça).
describe("CoachTrainingAttendanceController (HTTP)", () => {
  let app: INestApplication;
  let service: { getAttendanceSheet: jest.Mock; putAttendance: jest.Mock };
  let prisma: { coach_training_session: { findUnique: jest.Mock } };

  const COACH_ID = "c0ffee00-0000-4000-8000-000000000001";
  const TRAINING_ID = "aaaa1111-0000-4000-8000-000000000001";
  const ATHLETE_ID = "a1a1a1a1-0000-4000-8000-000000000001";

  let coachCookie: string;
  let athleteOnlyCookie: string;

  beforeEach(async () => {
    service = { getAttendanceSheet: jest.fn(), putAttendance: jest.fn() };
    prisma = { coach_training_session: { findUnique: jest.fn() } };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [CoachTrainingAttendanceController],
      providers: [
        { provide: CoachTrainingAttendanceService, useValue: service },
        { provide: PrismaService, useValue: prisma },
        JwtAuthGuard,
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

  describe("GET /coach/trainings/:trainingId/attendance", () => {
    it("sans authentification -> 401", async () => {
      await request(app.getHttpServer()).get(`/coach/trainings/${TRAINING_ID}/attendance`).expect(401);
    });

    it("athlete-only -> 403", async () => {
      await request(app.getHttpServer())
        .get(`/coach/trainings/${TRAINING_ID}/attendance`)
        .set("Cookie", athleteOnlyCookie)
        .expect(403);
      expect(service.getAttendanceSheet).not.toHaveBeenCalled();
    });

    it("séance d'un autre coach -> 403", async () => {
      prisma.coach_training_session.findUnique.mockResolvedValue({ coach_id: "un-autre-coach" });
      await request(app.getHttpServer())
        .get(`/coach/trainings/${TRAINING_ID}/attendance`)
        .set("Cookie", coachCookie)
        .expect(403);
      expect(service.getAttendanceSheet).not.toHaveBeenCalled();
    });

    it("séance inconnue -> 403 (jamais 404)", async () => {
      prisma.coach_training_session.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        .get(`/coach/trainings/${TRAINING_ID}/attendance`)
        .set("Cookie", coachCookie)
        .expect(403);
    });

    it("coach propriétaire -> 200", async () => {
      prisma.coach_training_session.findUnique.mockResolvedValue({ coach_id: COACH_ID });
      service.getAttendanceSheet.mockResolvedValue({ training: { id: TRAINING_ID }, athletes: [] });

      const res = await request(app.getHttpServer())
        .get(`/coach/trainings/${TRAINING_ID}/attendance`)
        .set("Cookie", coachCookie)
        .expect(200);

      expect(res.body.training.id).toBe(TRAINING_ID);
      expect(service.getAttendanceSheet).toHaveBeenCalledWith(TRAINING_ID);
    });
  });

  describe("PUT /coach/trainings/:trainingId/attendance", () => {
    const validBody = { attendances: [{ athleteId: ATHLETE_ID, status: "present" }] };

    it("sans authentification -> 401", async () => {
      await request(app.getHttpServer()).put(`/coach/trainings/${TRAINING_ID}/attendance`).send(validBody).expect(401);
    });

    it("séance d'un autre coach -> 403", async () => {
      prisma.coach_training_session.findUnique.mockResolvedValue({ coach_id: "un-autre-coach" });
      await request(app.getHttpServer())
        .put(`/coach/trainings/${TRAINING_ID}/attendance`)
        .set("Cookie", coachCookie)
        .send(validBody)
        .expect(403);
      expect(service.putAttendance).not.toHaveBeenCalled();
    });

    it("status invalide -> 400", async () => {
      prisma.coach_training_session.findUnique.mockResolvedValue({ coach_id: COACH_ID });
      await request(app.getHttpServer())
        .put(`/coach/trainings/${TRAINING_ID}/attendance`)
        .set("Cookie", coachCookie)
        .send({ attendances: [{ athleteId: ATHLETE_ID, status: "en-retard" }] })
        .expect(400);
      expect(service.putAttendance).not.toHaveBeenCalled();
    });

    it("athleteId non-UUID -> 400", async () => {
      prisma.coach_training_session.findUnique.mockResolvedValue({ coach_id: COACH_ID });
      await request(app.getHttpServer())
        .put(`/coach/trainings/${TRAINING_ID}/attendance`)
        .set("Cookie", coachCookie)
        .send({ attendances: [{ athleteId: "pas-un-uuid", status: "present" }] })
        .expect(400);
    });

    it("coachId/athleteId injectés dans le body -> rejetés (whitelist)", async () => {
      prisma.coach_training_session.findUnique.mockResolvedValue({ coach_id: COACH_ID });
      await request(app.getHttpServer())
        .put(`/coach/trainings/${TRAINING_ID}/attendance`)
        .set("Cookie", coachCookie)
        .send({ attendances: [{ athleteId: ATHLETE_ID, status: "present", recordedByCoachId: "spoof" }] })
        .expect(400);
      expect(service.putAttendance).not.toHaveBeenCalled();
    });

    it("coach propriétaire, payload valide -> 200", async () => {
      prisma.coach_training_session.findUnique.mockResolvedValue({ coach_id: COACH_ID });
      service.putAttendance.mockResolvedValue({ training: { id: TRAINING_ID }, athletes: [] });

      await request(app.getHttpServer())
        .put(`/coach/trainings/${TRAINING_ID}/attendance`)
        .set("Cookie", coachCookie)
        .send(validBody)
        .expect(200);

      expect(service.putAttendance).toHaveBeenCalledWith(TRAINING_ID, validBody);
    });
  });
});
