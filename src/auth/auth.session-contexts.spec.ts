import { Controller, Get, INestApplication, Req, UnauthorizedException, UseGuards, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import cookieParser from "cookie-parser";
import type { Request } from "express";
import request = require("supertest");
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { AthleteOwnershipGuard } from "./athlete-ownership.guard";
import { CoachGuard } from "./coach.guard";
import { AUTH_COOKIE_NAMES, LEGACY_AUTH_COOKIE_NAME } from "./auth.cookie";
import type { JwtPayload } from "./jwt-payload.interface";
import { InvitationsService } from "../invitations/invitations.service";
import { signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

const ATHLETE_ID = "240fe60f-6e74-46ea-87a0-45872bd1f4fe";
const COACH_ID = "6eeef373-29c5-471b-89d6-415b8edc875a";

const ATHLETE_ONLY: JwtPayload = { sub: "u-kais", athleteId: ATHLETE_ID };
const COACH_ONLY: JwtPayload = { sub: "u-sophie", coachId: COACH_ID };
const DUAL_ROLE: JwtPayload = { sub: "u-dual", athleteId: ATHLETE_ID, coachId: COACH_ID };

const ACCOUNTS: Record<string, JwtPayload> = {
  "kais@ekvara.fr": ATHLETE_ONLY,
  "sophie@ekvara.fr": COACH_ONLY,
  "dual@ekvara.fr": DUAL_ROLE,
};

// Routes sondes qui reprennent EXACTEMENT les guards des routes réelles :
// /coach/* (JwtAuthGuard + CoachGuard), /athletes/:athleteId/* (JwtAuthGuard +
// AthleteOwnershipGuard), et une route JwtAuthGuard seule (ex. /notifications).
@Controller()
class ProbeController {
  @Get("coach/me")
  @UseGuards(JwtAuthGuard, CoachGuard)
  coachMe(@Req() req: Request) {
    return { sub: req.user!.sub, coachId: req.user!.coachId };
  }

  @Get("athletes/:athleteId/probe")
  @UseGuards(JwtAuthGuard, AthleteOwnershipGuard)
  athleteProbe(@Req() req: Request) {
    return { sub: req.user!.sub, athleteId: req.user!.athleteId };
  }

  @Get("notifications")
  @UseGuards(JwtAuthGuard)
  shared(@Req() req: Request) {
    return { sub: req.user!.sub };
  }
}

function cookiesOf(res: request.Response): string[] {
  return (res.headers["set-cookie"] ?? []) as unknown as string[];
}

function cookieNamed(res: request.Response, name: string): string | undefined {
  return cookiesOf(res).find((c) => c.startsWith(`${name}=`));
}

describe("Sessions indépendantes Athlete / Coach (HTTP, guards réels)", () => {
  let app: INestApplication;
  let authService: { login: jest.Mock; register: jest.Mock; getMe: jest.Mock; getTokenRemainingMs: jest.Mock };

  beforeEach(async () => {
    authService = {
      register: jest.fn(),
      // Comme AuthService.login : payload construit à partir des profils du compte.
      login: jest.fn(async (dto: { email: string }) => {
        const payload = ACCOUNTS[dto.email];
        if (!payload) throw new UnauthorizedException("Email ou mot de passe incorrect");
        return { athlete: payload.athleteId ? { id: payload.athleteId } : null, token: signTestToken(payload) };
      }),
      getMe: jest.fn((athleteId?: string) => {
        if (!athleteId) throw new UnauthorizedException("Aucune session athlète");
        return { id: athleteId };
      }),
      getTokenRemainingMs: jest.fn().mockReturnValue(3_600_000),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [testJwtModule(), ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [AuthController, ProbeController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: InvitationsService, useValue: { validate: jest.fn() } },
        JwtAuthGuard,
        AthleteOwnershipGuard,
        CoachGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const login = (agent: request.Agent, email: string, appHeader?: string) => {
    const req = agent.post("/auth/login").send({ email, password: "x" });
    return appHeader ? req.set("X-Ekvara-App", appHeader) : req;
  };
  const athleteGet = (agent: request.Agent, path: string) => agent.get(path).set("X-Ekvara-App", "athlete");
  const coachGet = (agent: request.Agent, path: string) => agent.get(path).set("X-Ekvara-App", "coach");

  describe("cookie posé au login", () => {
    it("contexte coach -> uniquement ekvara_coach_token, HttpOnly, SameSite=Lax, Path=/, Max-Age, sans Domain", async () => {
      const res = await login(request.agent(app.getHttpServer()), "sophie@ekvara.fr", "coach").expect(200);

      const cookie = cookieNamed(res, AUTH_COOKIE_NAMES.coach);
      expect(cookie).toBeDefined();
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).toMatch(/Max-Age=\d+/i);
      expect(cookie).not.toMatch(/Domain=/i);
      expect(cookieNamed(res, AUTH_COOKIE_NAMES.athlete)).toBeUndefined();
      expect(cookieNamed(res, LEGACY_AUTH_COOKIE_NAME)).toBeUndefined();
    });

    it("contexte athlete -> uniquement ekvara_athlete_token", async () => {
      const res = await login(request.agent(app.getHttpServer()), "kais@ekvara.fr", "athlete").expect(200);

      expect(cookieNamed(res, AUTH_COOKIE_NAMES.athlete)).toBeDefined();
      expect(cookieNamed(res, AUTH_COOKIE_NAMES.coach)).toBeUndefined();
    });

    it("en-tête absent -> contexte par défaut athlete", async () => {
      const res = await login(request.agent(app.getHttpServer()), "kais@ekvara.fr").expect(200);

      expect(cookieNamed(res, AUTH_COOKIE_NAMES.athlete)).toBeDefined();
      expect(cookieNamed(res, AUTH_COOKIE_NAMES.coach)).toBeUndefined();
    });

    it("en-tête invalide -> 400, aucun cookie posé, service jamais appelé", async () => {
      const res = await login(request.agent(app.getHttpServer()), "sophie@ekvara.fr", "admin").expect(400);

      expect(cookiesOf(res)).toHaveLength(0);
      expect(authService.login).not.toHaveBeenCalled();
    });
  });

  describe("sessions simultanées et indépendantes (deux comptes différents, même navigateur)", () => {
    it("login Athlete puis login Coach : aucune connexion ne remplace l'autre, même en alternant", async () => {
      const browser = request.agent(app.getHttpServer());
      await login(browser, "kais@ekvara.fr", "athlete").expect(200);
      await login(browser, "sophie@ekvara.fr", "coach").expect(200);

      for (let round = 0; round < 3; round++) {
        const athlete = await athleteGet(browser, `/athletes/${ATHLETE_ID}/probe`).expect(200);
        expect(athlete.body).toEqual({ sub: "u-kais", athleteId: ATHLETE_ID });

        const coach = await coachGet(browser, "/coach/me").expect(200);
        expect(coach.body).toEqual({ sub: "u-sophie", coachId: COACH_ID });
      }
    });

    it("ordre inverse (Coach puis Athlete) : identique", async () => {
      const browser = request.agent(app.getHttpServer());
      await login(browser, "sophie@ekvara.fr", "coach").expect(200);
      await login(browser, "kais@ekvara.fr", "athlete").expect(200);

      expect((await coachGet(browser, "/notifications").expect(200)).body).toEqual({ sub: "u-sophie" });
      expect((await athleteGet(browser, "/notifications").expect(200)).body).toEqual({ sub: "u-kais" });
    });

    it("routes partagées (JwtAuthGuard seul) : chaque app est servie avec SA session", async () => {
      const browser = request.agent(app.getHttpServer());
      await login(browser, "kais@ekvara.fr", "athlete");
      await login(browser, "sophie@ekvara.fr", "coach");

      expect((await athleteGet(browser, "/notifications")).body.sub).toBe("u-kais");
      expect((await coachGet(browser, "/notifications")).body.sub).toBe("u-sophie");
    });
  });

  describe("logout indépendant", () => {
    it("logout Athlete : n'efface que le cookie athlete, la session Coach survit", async () => {
      const browser = request.agent(app.getHttpServer());
      await login(browser, "kais@ekvara.fr", "athlete");
      await login(browser, "sophie@ekvara.fr", "coach");

      const res = await browser.post("/auth/logout").set("X-Ekvara-App", "athlete").expect(200);

      expect(cookieNamed(res, AUTH_COOKIE_NAMES.athlete)).toMatch(/Expires=/i);
      expect(cookieNamed(res, AUTH_COOKIE_NAMES.coach)).toBeUndefined();

      await athleteGet(browser, "/auth/me").expect(401);
      await coachGet(browser, "/coach/me").expect(200);
    });

    it("logout Coach : n'efface que le cookie coach, la session Athlete survit", async () => {
      const browser = request.agent(app.getHttpServer());
      await login(browser, "kais@ekvara.fr", "athlete");
      await login(browser, "sophie@ekvara.fr", "coach");

      const res = await browser.post("/auth/logout").set("X-Ekvara-App", "coach").expect(200);

      expect(cookieNamed(res, AUTH_COOKIE_NAMES.coach)).toMatch(/Expires=/i);
      expect(cookieNamed(res, AUTH_COOKIE_NAMES.athlete)).toBeUndefined();

      await coachGet(browser, "/coach/me").expect(401);
      await athleteGet(browser, "/auth/me").expect(200);
    });

    it("logout nettoie aussi l'ancien cookie partagé (ekvara_auth_token) sans toucher l'autre app", async () => {
      const res = await request(app.getHttpServer()).post("/auth/logout").set("X-Ekvara-App", "coach").expect(200);

      expect(cookieNamed(res, LEGACY_AUTH_COOKIE_NAME)).toMatch(/Expires=/i);
      expect(cookieNamed(res, AUTH_COOKIE_NAMES.athlete)).toBeUndefined();
    });

    it("logout avec en-tête invalide -> 400", async () => {
      await request(app.getHttpServer()).post("/auth/logout").set("X-Ekvara-App", "root").expect(400);
    });
  });

  describe("401 : session absente, invalide, expirée, ou d'un autre contexte", () => {
    it("sans cookie -> 401 dans les deux contextes", async () => {
      await request(app.getHttpServer()).get("/coach/me").set("X-Ekvara-App", "coach").expect(401);
      await request(app.getHttpServer()).get("/auth/me").set("X-Ekvara-App", "athlete").expect(401);
    });

    it("JWT expiré dans le cookie du contexte -> 401 (pas 403)", async () => {
      const expired = signTestToken(COACH_ONLY, "-1s");
      await request(app.getHttpServer())
        .get("/coach/me")
        .set("X-Ekvara-App", "coach")
        .set("Cookie", `${AUTH_COOKIE_NAMES.coach}=${expired}`)
        .expect(401);
    });

    it("signature invalide -> 401", async () => {
      await request(app.getHttpServer())
        .get("/coach/me")
        .set("X-Ekvara-App", "coach")
        .set("Cookie", `${AUTH_COOKIE_NAMES.coach}=pas-un-jwt`)
        .expect(401);
    });

    it("le cookie de l'AUTRE contexte n'est jamais lu : session athlete valide + en-tête coach -> 401", async () => {
      await request(app.getHttpServer())
        .get("/coach/me")
        .set("X-Ekvara-App", "coach")
        .set("Cookie", `${AUTH_COOKIE_NAMES.athlete}=${signTestToken(DUAL_ROLE)}`)
        .expect(401);
    });

    it("l'ancien cookie partagé n'authentifie plus personne (sinon le bug de mélange de sessions reviendrait)", async () => {
      const legacy = `${LEGACY_AUTH_COOKIE_NAME}=${signTestToken(DUAL_ROLE)}`;
      await request(app.getHttpServer()).get("/coach/me").set("X-Ekvara-App", "coach").set("Cookie", legacy).expect(401);
      await request(app.getHttpServer()).get("/auth/me").set("X-Ekvara-App", "athlete").set("Cookie", legacy).expect(401);
    });
  });

  describe("403 : un vrai refus d'autorisation reste un 403", () => {
    it("session athlete-only dans le cookie coach -> 403 « Accès réservé aux comptes coach » (authentifié, pas coach)", async () => {
      const res = await request(app.getHttpServer())
        .get("/coach/me")
        .set("X-Ekvara-App", "coach")
        .set("Cookie", `${AUTH_COOKIE_NAMES.coach}=${signTestToken(ATHLETE_ONLY)}`)
        .expect(403);

      expect(res.body.message).toBe("Accès réservé aux comptes coach");
    });

    it("athleteId d'un autre athlète dans le chemin -> 403 (AthleteOwnershipGuard inchangé)", async () => {
      await request(app.getHttpServer())
        .get("/athletes/aaaaaaaa-1111-4111-8111-111111111111/probe")
        .set("X-Ekvara-App", "athlete")
        .set("Cookie", `${AUTH_COOKIE_NAMES.athlete}=${signTestToken(ATHLETE_ONLY)}`)
        .expect(403);
    });

    it("session coach-only dans le cookie athlete -> 403 sur /athletes/:id, 401 sur /auth/me", async () => {
      const cookie = `${AUTH_COOKIE_NAMES.athlete}=${signTestToken(COACH_ONLY)}`;
      await request(app.getHttpServer()).get(`/athletes/${ATHLETE_ID}/probe`).set("X-Ekvara-App", "athlete").set("Cookie", cookie).expect(403);
      await request(app.getHttpServer()).get("/auth/me").set("X-Ekvara-App", "athlete").set("Cookie", cookie).expect(401);
    });

    it("X-Ekvara-App n'accorde AUCUN droit : un compte athlete-only qui envoie 'coach' avec son cookie coach reste refusé", async () => {
      // Le header ne fait que choisir le cookie ; l'autorisation vient du
      // payload du JWT vérifié (coachId), jamais de la valeur de l'en-tête.
      const browser = request.agent(app.getHttpServer());
      await login(browser, "kais@ekvara.fr", "coach").expect(200); // cookie coach = token athlete-only
      await coachGet(browser, "/coach/me").expect(403);
    });
  });

  describe("compte dual-role (athleteId + coachId)", () => {
    it("une session par application, chacune valide, chacune autorisée par le payload", async () => {
      const browser = request.agent(app.getHttpServer());
      await login(browser, "dual@ekvara.fr", "athlete").expect(200);
      await login(browser, "dual@ekvara.fr", "coach").expect(200);

      expect((await coachGet(browser, "/coach/me").expect(200)).body.coachId).toBe(COACH_ID);
      expect((await athleteGet(browser, `/athletes/${ATHLETE_ID}/probe`).expect(200)).body.athleteId).toBe(ATHLETE_ID);
    });

    it("logout d'un contexte n'invalide pas l'autre, même pour le même compte", async () => {
      const browser = request.agent(app.getHttpServer());
      await login(browser, "dual@ekvara.fr", "athlete");
      await login(browser, "dual@ekvara.fr", "coach");

      await browser.post("/auth/logout").set("X-Ekvara-App", "coach").expect(200);

      await coachGet(browser, "/coach/me").expect(401);
      await athleteGet(browser, `/athletes/${ATHLETE_ID}/probe`).expect(200);
    });

    it("connecté seulement côté athlete : le contexte coach reste 401 (pas de session coach implicite)", async () => {
      const browser = request.agent(app.getHttpServer());
      await login(browser, "dual@ekvara.fr", "athlete");

      await coachGet(browser, "/coach/me").expect(401);
    });
  });
});
