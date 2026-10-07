import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { CoachController } from "./coach.controller";
import { CoachService } from "./coach.service";
import { AthletesService } from "../athletes/athletes.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGuard } from "../auth/coach.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { PrismaService } from "../prisma/prisma.service";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

// Guards réels (JwtAuthGuard, CoachGuard, CoachAthleteAccessGuard) : seuls
// CoachService, AthletesService et l'accès DB de CoachAthleteAccessGuard sont
// mockés. Valide le câblage guard <-> route de bout en bout, pas seulement
// le service (même esprit que athletes.controller.spec.ts).
describe("CoachController (HTTP)", () => {
  let app: INestApplication;
  let coachService: { getMe: jest.Mock; removeAthlete: jest.Mock; listAthletes: jest.Mock };
  let athletesService: { findOne: jest.Mock };
  let prisma: { coach_athlete: { findUnique: jest.Mock } };

  const COACH_ID = "c0ffee00-0000-4000-8000-000000000001";
  const ATHLETE_ID = "a1a1a1a1-0000-4000-8000-000000000001";

  let coachCookie: string;
  let athleteOnlyCookie: string;

  beforeEach(async () => {
    coachService = {
      getMe: jest.fn(),
      removeAthlete: jest.fn(),
      listAthletes: jest.fn(),
    };
    athletesService = { findOne: jest.fn() };
    prisma = { coach_athlete: { findUnique: jest.fn() } };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [CoachController],
      providers: [
        { provide: CoachService, useValue: coachService },
        { provide: AthletesService, useValue: athletesService },
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

  describe("GET /coach/me", () => {
    it("sans authentification -> 401", async () => {
      await request(app.getHttpServer()).get("/coach/me").expect(401);
    });

    it("athlete-only (pas de coachId) -> 403", async () => {
      await request(app.getHttpServer()).get("/coach/me").set("Cookie", athleteOnlyCookie).expect(403);
      expect(coachService.getMe).not.toHaveBeenCalled();
    });

    it("coach authentifié -> 200", async () => {
      coachService.getMe.mockResolvedValue({ id: COACH_ID, user: { id: "u-1" }, club: null });

      const res = await request(app.getHttpServer()).get("/coach/me").set("Cookie", coachCookie).expect(200);

      expect(res.body.id).toBe(COACH_ID);
      expect(coachService.getMe).toHaveBeenCalledWith(COACH_ID);
    });
  });

  describe("POST /coach/athletes (supprimée)", () => {
    // Un athlète ne rejoint un coach que via le code d'invitation à
    // l'inscription : un coach ne peut jamais s'attribuer un athlète par email.
    it("coach valide -> 404, la route n'existe plus", async () => {
      await request(app.getHttpServer())
        .post("/coach/athletes")
        .set("Cookie", coachCookie)
        .send({ email: "athlete@test.fr" })
        .expect(404);
    });
  });

  describe("GET /coach/athletes", () => {
    it("athlete-only -> 403", async () => {
      await request(app.getHttpServer()).get("/coach/athletes").set("Cookie", athleteOnlyCookie).expect(403);
    });

    it("coach sans athlète -> 200 []", async () => {
      coachService.listAthletes.mockResolvedValue([]);

      const res = await request(app.getHttpServer()).get("/coach/athletes").set("Cookie", coachCookie).expect(200);

      expect(res.body).toEqual([]);
    });
  });

  describe("GET /coach/athletes/:athleteId (CoachAthleteAccessGuard)", () => {
    it("sans authentification -> 401", async () => {
      await request(app.getHttpServer()).get(`/coach/athletes/${ATHLETE_ID}`).expect(401);
    });

    it("athlete-only (pas de coachId) -> 403, pas de requête DB", async () => {
      await request(app.getHttpServer())
        .get(`/coach/athletes/${ATHLETE_ID}`)
        .set("Cookie", athleteOnlyCookie)
        .expect(403);
      expect(prisma.coach_athlete.findUnique).not.toHaveBeenCalled();
    });

    it("athlete non assigné (coach_athlete absent) -> 403, jamais 404 (pas de fuite d'existence)", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .get(`/coach/athletes/${ATHLETE_ID}`)
        .set("Cookie", coachCookie)
        .expect(403);
      expect(athletesService.findOne).not.toHaveBeenCalled();
    });

    it("athlete assigné -> 200, réutilise AthletesService.findOne (aucune duplication de logique)", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      athletesService.findOne.mockResolvedValue({ id: ATHLETE_ID, app_user: { email: "a@test.fr" } });

      const res = await request(app.getHttpServer())
        .get(`/coach/athletes/${ATHLETE_ID}`)
        .set("Cookie", coachCookie)
        .expect(200);

      expect(res.body.id).toBe(ATHLETE_ID);
      expect(athletesService.findOne).toHaveBeenCalledWith(ATHLETE_ID);
      expect(prisma.coach_athlete.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { coach_id_athlete_id: { coach_id: COACH_ID, athlete_id: ATHLETE_ID } },
        }),
      );
    });

    it("UUID malformé dans l'URL -> 403 (jamais atteindre Prisma avec un id invalide)", async () => {
      await request(app.getHttpServer())
        .get("/coach/athletes/pas-un-uuid")
        .set("Cookie", coachCookie)
        .expect(403);
      expect(prisma.coach_athlete.findUnique).not.toHaveBeenCalled();
    });

    it("coach A ne peut pas voir un athlete assigné à coach B", async () => {
      // simule : le lien existe uniquement pour coach B (findUnique filtré côté
      // requête réelle par coach_id ; ici on simule l'absence pour coach A).
      prisma.coach_athlete.findUnique.mockResolvedValue(null);
      const coachACookie = authCookieHeader(signTestToken({ sub: "u-coach-a", coachId: COACH_ID }));

      await request(app.getHttpServer())
        .get(`/coach/athletes/${ATHLETE_ID}`)
        .set("Cookie", coachACookie)
        .expect(403);
    });
  });

  describe("DELETE /coach/athletes/:athleteId", () => {
    it("athlete non assigné -> 403", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .delete(`/coach/athletes/${ATHLETE_ID}`)
        .set("Cookie", coachCookie)
        .expect(403);
      expect(coachService.removeAthlete).not.toHaveBeenCalled();
    });

    it("athlete assigné -> 204, délègue au service", async () => {
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      coachService.removeAthlete.mockResolvedValue(undefined);

      await request(app.getHttpServer())
        .delete(`/coach/athletes/${ATHLETE_ID}`)
        .set("Cookie", coachCookie)
        .expect(204);

      expect(coachService.removeAthlete).toHaveBeenCalledWith(COACH_ID, ATHLETE_ID);
    });
  });
});
