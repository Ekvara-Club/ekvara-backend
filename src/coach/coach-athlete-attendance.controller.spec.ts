import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { CoachAthleteAttendanceController } from "./coach-athlete-attendance.controller";
import { CoachTrainingAttendanceService } from "./coach-training-attendance.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { PrismaService } from "../prisma/prisma.service";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

describe("CoachAthleteAttendanceController (HTTP)", () => {
  let app: INestApplication;
  let service: { getAthleteSummary: jest.Mock };
  let prisma: { coach_athlete: { findUnique: jest.Mock } };

  const COACH_ID = "c0ffee00-0000-4000-8000-000000000001";
  const ATHLETE_ID = "a1a1a1a1-0000-4000-8000-000000000001";

  let coachCookie: string;
  let athleteOnlyCookie: string;

  beforeEach(async () => {
    service = { getAthleteSummary: jest.fn() };
    prisma = { coach_athlete: { findUnique: jest.fn() } };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [CoachAthleteAttendanceController],
      providers: [
        { provide: CoachTrainingAttendanceService, useValue: service },
        { provide: PrismaService, useValue: prisma },
        JwtAuthGuard,
        CoachAthleteAccessGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    coachCookie = authCookieHeader(signTestToken({ sub: "u-coach", coachId: COACH_ID }));
    athleteOnlyCookie = authCookieHeader(signTestToken({ sub: "u-athlete", athleteId: "a-anything" }));
  });

  afterEach(async () => {
    await app.close();
  });

  it("sans authentification -> 401", async () => {
    await request(app.getHttpServer()).get(`/coach/athletes/${ATHLETE_ID}/attendance/summary`).expect(401);
  });

  it("athlete-only -> 403", async () => {
    await request(app.getHttpServer())
      .get(`/coach/athletes/${ATHLETE_ID}/attendance/summary`)
      .set("Cookie", athleteOnlyCookie)
      .expect(403);
    expect(service.getAthleteSummary).not.toHaveBeenCalled();
  });

  it("athlète non lié à ce coach -> 403", async () => {
    prisma.coach_athlete.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get(`/coach/athletes/${ATHLETE_ID}/attendance/summary`)
      .set("Cookie", coachCookie)
      .expect(403);
    expect(service.getAthleteSummary).not.toHaveBeenCalled();
  });

  it("athlète lié -> 200, coachId vient du JWT (jamais du client)", async () => {
    prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
    service.getAthleteSummary.mockResolvedValue({
      last30Days: { eligibleSessions: 0, recordedSessions: 0, present: 0, absent: 0, excused: 0, attendanceRate: null },
    });

    const res = await request(app.getHttpServer())
      .get(`/coach/athletes/${ATHLETE_ID}/attendance/summary`)
      .set("Cookie", coachCookie)
      .expect(200);

    expect(res.body.last30Days.attendanceRate).toBeNull();
    expect(service.getAthleteSummary).toHaveBeenCalledWith(COACH_ID, ATHLETE_ID);
  });
});
