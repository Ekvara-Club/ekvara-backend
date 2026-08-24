import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, INestApplication, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { CoachDashboardController } from "./coach-dashboard.controller";
import { CoachDashboardService } from "./coach-dashboard.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGuard } from "../auth/coach.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { PrismaService } from "../prisma/prisma.service";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

describe("CoachDashboardController (HTTP)", () => {
  let app: INestApplication;
  let service: { getDashboard: jest.Mock; getAthleteSummaries: jest.Mock; getAthleteDashboard: jest.Mock };
  let prisma: { coach_athlete: { findUnique: jest.Mock } };

  const COACH_ID = "c0ffee00-0000-4000-8000-000000000001";
  const ATHLETE_ID = "a1a1a1a1-0000-4000-8000-000000000001";
  const GROUP_ID = "9999aaaa-0000-4000-8000-000000000001";

  let coachCookie: string;
  let athleteOnlyCookie: string;

  beforeEach(async () => {
    service = {
      getDashboard: jest.fn(),
      getAthleteSummaries: jest.fn(),
      getAthleteDashboard: jest.fn(),
    };
    prisma = { coach_athlete: { findUnique: jest.fn() } };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [CoachDashboardController],
      providers: [
        { provide: CoachDashboardService, useValue: service },
        { provide: PrismaService, useValue: prisma },
        JwtAuthGuard,
        CoachGuard,
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

  describe("GET /coach/dashboard", () => {
    it("sans authentification -> 401", async () => {
      await request(app.getHttpServer()).get("/coach/dashboard").expect(401);
    });

    it("athlete-only -> 403", async () => {
      await request(app.getHttpServer()).get("/coach/dashboard").set("Cookie", athleteOnlyCookie).expect(403);
      expect(service.getDashboard).not.toHaveBeenCalled();
    });

    it("coach authentifié -> 200, délègue au service", async () => {
      service.getDashboard.mockResolvedValue({
        summary: { athleteCount: 0 },
        groups: [],
        upcomingCompetitions: [],
        athletesNeedingAttention: [],
        recentActivity: [],
      });

      const res = await request(app.getHttpServer()).get("/coach/dashboard").set("Cookie", coachCookie).expect(200);

      expect(res.body.summary.athleteCount).toBe(0);
      expect(service.getDashboard).toHaveBeenCalledWith(COACH_ID);
    });
  });

  describe("GET /coach/dashboard/athletes", () => {
    it("athlete-only -> 403", async () => {
      await request(app.getHttpServer()).get("/coach/dashboard/athletes").set("Cookie", athleteOnlyCookie).expect(403);
    });

    it("sans groupId -> 200, appelle le service avec groupId undefined", async () => {
      service.getAthleteSummaries.mockResolvedValue([]);

      await request(app.getHttpServer()).get("/coach/dashboard/athletes").set("Cookie", coachCookie).expect(200);

      expect(service.getAthleteSummaries).toHaveBeenCalledWith(COACH_ID, undefined);
    });

    it("avec ?groupId=<uuid> -> transmis au service", async () => {
      service.getAthleteSummaries.mockResolvedValue([]);

      await request(app.getHttpServer())
        .get(`/coach/dashboard/athletes?groupId=${GROUP_ID}`)
        .set("Cookie", coachCookie)
        .expect(200);

      expect(service.getAthleteSummaries).toHaveBeenCalledWith(COACH_ID, GROUP_ID);
    });

    it("groupId malformé -> 400 (ValidationPipe), jamais atteindre le service", async () => {
      await request(app.getHttpServer())
        .get("/coach/dashboard/athletes?groupId=pas-un-uuid")
        .set("Cookie", coachCookie)
        .expect(400);
      expect(service.getAthleteSummaries).not.toHaveBeenCalled();
    });

    it("groupId d'un autre coach -> 403 (ForbiddenException propagée par le service)", async () => {
      service.getAthleteSummaries.mockRejectedValue(new ForbiddenException("Accès interdit à ce groupe"));

      await request(app.getHttpServer())
        .get(`/coach/dashboard/athletes?groupId=${GROUP_ID}`)
        .set("Cookie", coachCookie)
        .expect(403);
    });
  });

  describe("GET /coach/athletes/:athleteId/dashboard", () => {
    it("athlete non assigné (coach_athlete absent) -> 403, jamais le service", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .get(`/coach/athletes/${ATHLETE_ID}/dashboard`)
        .set("Cookie", coachCookie)
        .expect(403);
      expect(service.getAthleteDashboard).not.toHaveBeenCalled();
    });

    it("athlete assigné -> 200, délègue au service", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      service.getAthleteDashboard.mockResolvedValue({ id: ATHLETE_ID, firstName: "Kais" });

      const res = await request(app.getHttpServer())
        .get(`/coach/athletes/${ATHLETE_ID}/dashboard`)
        .set("Cookie", coachCookie)
        .expect(200);

      expect(res.body.id).toBe(ATHLETE_ID);
      expect(service.getAthleteDashboard).toHaveBeenCalledWith(COACH_ID, ATHLETE_ID);
    });

    it("UUID malformé -> 403 (jamais atteindre Prisma/le service)", async () => {
      await request(app.getHttpServer())
        .get("/coach/athletes/pas-un-uuid/dashboard")
        .set("Cookie", coachCookie)
        .expect(403);
      expect(service.getAthleteDashboard).not.toHaveBeenCalled();
    });
  });
});
