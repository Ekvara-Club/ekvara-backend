import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { CoachCompetitionsController } from "./coach-competitions.controller";
import { CoachCompetitionsService } from "./coach-competitions.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGuard } from "../auth/coach.guard";
import { CoachCompetitionOwnershipGuard } from "../auth/coach-competition-ownership.guard";
import { PrismaService } from "../prisma/prisma.service";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

describe("CoachCompetitionsController (HTTP)", () => {
  let app: INestApplication;
  let service: { getCompetitions: jest.Mock; getCompetitionDetail: jest.Mock };
  let prisma: { coach_athlete: { findFirst: jest.Mock }; coach_competition_preparation: { findFirst: jest.Mock } };

  const COACH_ID = "c0ffee00-0000-4000-8000-000000000001";
  const OTHER_COACH_ID = "c0ffee00-0000-4000-8000-000000000009";
  const COMPETITION_ID = "cccc1111-0000-4000-8000-000000000001";

  let coachCookie: string;
  let athleteOnlyCookie: string;

  beforeEach(async () => {
    service = { getCompetitions: jest.fn(), getCompetitionDetail: jest.fn() };
    prisma = { coach_athlete: { findFirst: jest.fn() }, coach_competition_preparation: { findFirst: jest.fn() } };
    // Par défaut, aucune préparation trouvée — un test qui veut vérifier le
    // chemin "accès via préparation" override explicitement ce mock.
    prisma.coach_competition_preparation.findFirst.mockResolvedValue(null);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [CoachCompetitionsController],
      providers: [
        { provide: CoachCompetitionsService, useValue: service },
        { provide: PrismaService, useValue: prisma },
        JwtAuthGuard,
        CoachGuard,
        CoachCompetitionOwnershipGuard,
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

  describe("GET /coach/competitions", () => {
    it("sans authentification -> 401", async () => {
      await request(app.getHttpServer()).get("/coach/competitions").expect(401);
    });

    it("athlete-only -> 403", async () => {
      await request(app.getHttpServer()).get("/coach/competitions").set("Cookie", athleteOnlyCookie).expect(403);
      expect(service.getCompetitions).not.toHaveBeenCalled();
    });

    it("coach valide -> 200, coachId vient exclusivement du JWT (jamais d'un ?coachId= client)", async () => {
      service.getCompetitions.mockResolvedValue({ upcoming: [], past: [] });

      const res = await request(app.getHttpServer())
        .get(`/coach/competitions?coachId=${OTHER_COACH_ID}`)
        .set("Cookie", coachCookie)
        .expect(200);

      expect(res.body).toEqual({ upcoming: [], past: [] });
      expect(service.getCompetitions).toHaveBeenCalledWith(COACH_ID);
    });
  });

  describe("GET /coach/competitions/:competitionId (CoachCompetitionOwnershipGuard)", () => {
    it("sans authentification -> 401", async () => {
      await request(app.getHttpServer()).get(`/coach/competitions/${COMPETITION_ID}`).expect(401);
    });

    it("UUID invalide -> 403 (jamais 404, jamais un 400 qui confirmerait le format attendu à un tiers)", async () => {
      await request(app.getHttpServer())
        .get("/coach/competitions/pas-un-uuid")
        .set("Cookie", coachCookie)
        .expect(403);
      expect(prisma.coach_athlete.findFirst).not.toHaveBeenCalled();
    });

    it("aucun athlète du roster lié à cette compétition ET aucune préparation -> 403 (jamais 404)", async () => {
      prisma.coach_athlete.findFirst.mockResolvedValue(null);
      prisma.coach_competition_preparation.findFirst.mockResolvedValue(null);
      await request(app.getHttpServer())
        .get(`/coach/competitions/${COMPETITION_ID}`)
        .set("Cookie", coachCookie)
        .expect(403);
      expect(service.getCompetitionDetail).not.toHaveBeenCalled();
    });

    it("aucune participation mais une préparation existante -> 200 (ticket Sélection & préparation V1 §21)", async () => {
      prisma.coach_athlete.findFirst.mockResolvedValue(null);
      prisma.coach_competition_preparation.findFirst.mockResolvedValue({ id: "prep-1" });
      service.getCompetitionDetail.mockResolvedValue({ competition: { id: COMPETITION_ID }, athleteCount: 1, athletes: [] });

      await request(app.getHttpServer())
        .get(`/coach/competitions/${COMPETITION_ID}`)
        .set("Cookie", coachCookie)
        .expect(200);

      expect(service.getCompetitionDetail).toHaveBeenCalledWith(COACH_ID, COMPETITION_ID);
    });

    it("athlete-only -> 403 avant même la requête d'ownership", async () => {
      await request(app.getHttpServer())
        .get(`/coach/competitions/${COMPETITION_ID}`)
        .set("Cookie", athleteOnlyCookie)
        .expect(403);
      expect(prisma.coach_athlete.findFirst).not.toHaveBeenCalled();
    });

    it("au moins un athlète lié -> 200", async () => {
      prisma.coach_athlete.findFirst.mockResolvedValue({ athlete_id: "a-1" });
      service.getCompetitionDetail.mockResolvedValue({ competition: { id: COMPETITION_ID }, athleteCount: 1, athletes: [] });

      const res = await request(app.getHttpServer())
        .get(`/coach/competitions/${COMPETITION_ID}`)
        .set("Cookie", coachCookie)
        .expect(200);

      expect(res.body.athleteCount).toBe(1);
      expect(service.getCompetitionDetail).toHaveBeenCalledWith(COACH_ID, COMPETITION_ID);
      expect(prisma.coach_athlete.findFirst).toHaveBeenCalledWith({
        where: { coach_id: COACH_ID, athlete: { participation: { some: { competition_id: COMPETITION_ID } } } },
        select: { athlete_id: true },
      });
    });
  });
});
