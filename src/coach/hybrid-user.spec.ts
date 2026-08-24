import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { AthletesController } from "../athletes/athletes.controller";
import { AthletesService } from "../athletes/athletes.service";
import { CoachController } from "./coach.controller";
import { CoachService } from "./coach.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AthleteOwnershipGuard } from "../auth/athlete-ownership.guard";
import { CoachGuard } from "../auth/coach.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { PrismaService } from "../prisma/prisma.service";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

// Ticket §29 : un même utilisateur hybride (athlete + coach_profile) doit
// pouvoir utiliser les deux univers avec le MÊME token, sans que l'un
// interfère avec l'autre. AthleteOwnershipGuard et CoachGuard/
// CoachAthleteAccessGuard lisent des champs différents et indépendants du
// payload (athleteId vs coachId) : ce test le prouve à l'exécution, pas
// seulement sur la forme du payload (déjà couvert par auth.service.spec.ts).
describe("Utilisateur hybride athlete + coach (HTTP, un seul token)", () => {
  let app: INestApplication;
  let athletesService: { findOne: jest.Mock };
  let coachService: { getMe: jest.Mock };
  let prisma: { coach_athlete: { findUnique: jest.Mock } };

  const ATHLETE_ID = "a1a1a1a1-0000-4000-8000-000000000099";
  const COACH_ID = "c0ffee00-0000-4000-8000-000000000099";
  const OTHER_ATHLETE_ID = "a1a1a1a1-0000-4000-8000-000000000088";

  let hybridCookie: string;

  beforeEach(async () => {
    athletesService = { findOne: jest.fn() };
    coachService = { getMe: jest.fn() };
    prisma = { coach_athlete: { findUnique: jest.fn() } };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [AthletesController, CoachController],
      providers: [
        { provide: AthletesService, useValue: athletesService },
        { provide: CoachService, useValue: coachService },
        { provide: PrismaService, useValue: prisma },
        JwtAuthGuard,
        AthleteOwnershipGuard,
        CoachGuard,
        CoachAthleteAccessGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    hybridCookie = authCookieHeader(
      signTestToken({ sub: "u-hybrid", athleteId: ATHLETE_ID, coachId: COACH_ID }),
    );
  });

  afterEach(async () => {
    await app.close();
  });

  it("le même token accède à sa propre fiche athlète (AthleteOwnershipGuard) ET à /coach/me (CoachGuard)", async () => {
    athletesService.findOne.mockResolvedValue({ id: ATHLETE_ID });
    coachService.getMe.mockResolvedValue({ id: COACH_ID });

    await request(app.getHttpServer())
      .get(`/athletes/${ATHLETE_ID}`)
      .set("Cookie", hybridCookie)
      .expect(200);

    await request(app.getHttpServer()).get("/coach/me").set("Cookie", hybridCookie).expect(200);
  });

  it("le volet coach du token ne donne aucun accès élargi côté athlete : reste bloqué sur un autre athleteId", async () => {
    await request(app.getHttpServer())
      .get(`/athletes/${OTHER_ATHLETE_ID}`)
      .set("Cookie", hybridCookie)
      .expect(403);
  });

  it("le volet athlete du token ne donne aucun accès côté coach à un athlète non assigné (coach_athlete absent)", async () => {
    prisma.coach_athlete.findUnique.mockResolvedValue(null);

    await request(app.getHttpServer())
      .get(`/coach/athletes/${ATHLETE_ID}`)
      .set("Cookie", hybridCookie)
      .expect(403);
  });

  it("assigné via coach_athlete -> l'accès coach fonctionne indépendamment du profil athlete du même utilisateur", async () => {
    prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
    athletesService.findOne.mockResolvedValue({ id: OTHER_ATHLETE_ID });

    await request(app.getHttpServer())
      .get(`/coach/athletes/${OTHER_ATHLETE_ID}`)
      .set("Cookie", hybridCookie)
      .expect(200);
  });
});
