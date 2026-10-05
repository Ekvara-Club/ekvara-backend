import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { AthleteWtLinkController, CoachWtLinkController } from "./wt-links.controller";
import { WtLinksService } from "./wt-links.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AthleteOwnershipGuard } from "../auth/athlete-ownership.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { PrismaService } from "../prisma/prisma.service";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

describe("WT profile links (HTTP)", () => {
  let app: INestApplication;
  const service = { getForAthlete: jest.fn(), request: jest.fn(), unlink: jest.fn(), decide: jest.fn() };
  const prisma = { coach_athlete: { findUnique: jest.fn() } };

  const ATHLETE_ID = "240fe60f-6e74-46ea-87a0-45872bd1f4fe";
  const OTHER_ATHLETE_ID = "aaaaaaaa-1111-4111-8111-111111111111";
  const EXT_ID = "e0e0e0e0-0000-4000-8000-000000000001";
  const athleteCookie = () => authCookieHeader(signTestToken({ sub: "u-athlete", athleteId: ATHLETE_ID }));
  const otherAthleteCookie = () => authCookieHeader(signTestToken({ sub: "u-other", athleteId: OTHER_ATHLETE_ID }));
  const coachCookie = () => authCookieHeader(signTestToken({ sub: "u-coach", coachId: "c0ffee00-0000-4000-8000-000000000001" }));

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [AthleteWtLinkController, CoachWtLinkController],
      providers: [
        { provide: WtLinksService, useValue: service },
        { provide: PrismaService, useValue: prisma },
        JwtAuthGuard,
        AthleteOwnershipGuard,
        CoachAthleteAccessGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.resetAllMocks();
  });

  describe("athlète", () => {
    it("lien d'un AUTRE athlète -> 403 (lecture comme demande)", async () => {
      await request(app.getHttpServer()).get(`/athletes/${ATHLETE_ID}/wt-profile`).set("Cookie", otherAthleteCookie()).expect(403);
      await request(app.getHttpServer())
        .put(`/athletes/${ATHLETE_ID}/wt-profile`)
        .set("Cookie", otherAthleteCookie())
        .send({ externalAthleteId: EXT_ID })
        .expect(403);
      expect(service.request).not.toHaveBeenCalled();
    });

    it("externalAthleteId non UUID -> 400", async () => {
      await request(app.getHttpServer())
        .put(`/athletes/${ATHLETE_ID}/wt-profile`)
        .set("Cookie", athleteCookie())
        .send({ externalAthleteId: "pas-un-uuid" })
        .expect(400);
    });

    it("demande -> 200, acteur issu du JWT ; retrait -> 200", async () => {
      service.request.mockResolvedValue({ link: { status: "pending" }, suggestions: [] });
      service.unlink.mockResolvedValue({ link: null, suggestions: [] });

      await request(app.getHttpServer())
        .put(`/athletes/${ATHLETE_ID}/wt-profile`)
        .set("Cookie", athleteCookie())
        .send({ externalAthleteId: EXT_ID })
        .expect(200);
      await request(app.getHttpServer()).delete(`/athletes/${ATHLETE_ID}/wt-profile`).set("Cookie", athleteCookie()).expect(200);

      expect(service.request).toHaveBeenCalledWith(ATHLETE_ID, "u-athlete", EXT_ID);
      expect(service.unlink).toHaveBeenCalledWith(ATHLETE_ID);
    });
  });

  describe("coach", () => {
    it("un athlète ne peut jamais confirmer son propre lien -> 403", async () => {
      await request(app.getHttpServer()).post(`/coach/athletes/${ATHLETE_ID}/wt-profile/confirm`).set("Cookie", athleteCookie()).expect(403);
      expect(service.decide).not.toHaveBeenCalled();
    });

    it("coach qui ne suit pas cet athlète -> 403", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer()).post(`/coach/athletes/${ATHLETE_ID}/wt-profile/confirm`).set("Cookie", coachCookie()).expect(403);
      expect(service.decide).not.toHaveBeenCalled();
    });

    it("coach de l'athlète -> confirme / refuse (200)", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      service.decide.mockResolvedValue(undefined);

      const confirmed = await request(app.getHttpServer())
        .post(`/coach/athletes/${ATHLETE_ID}/wt-profile/confirm`)
        .set("Cookie", coachCookie())
        .expect(200);
      await request(app.getHttpServer()).post(`/coach/athletes/${ATHLETE_ID}/wt-profile/reject`).set("Cookie", coachCookie()).expect(200);

      expect(confirmed.body).toEqual({ status: "confirmed" });
      expect(service.decide).toHaveBeenNthCalledWith(1, ATHLETE_ID, "u-coach", "confirm");
      expect(service.decide).toHaveBeenNthCalledWith(2, ATHLETE_ID, "u-coach", "reject");
    });
  });
});
