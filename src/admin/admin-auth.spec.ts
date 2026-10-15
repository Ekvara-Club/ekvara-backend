import { Controller, Get, INestApplication, Patch, Req, UseGuards, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ThrottlerModule } from "@nestjs/throttler";
import * as argon2 from "argon2";
import cookieParser from "cookie-parser";
import type { Request } from "express";
import request = require("supertest");
import { PrismaService } from "../prisma/prisma.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AUTH_COOKIE_NAMES } from "../auth/auth.cookie";
import { authCookieHeader, signTestToken, TEST_JWT_SECRET, testJwtModule } from "../test-utils/auth-test.helper";
import { AdminAuditLogger } from "./admin-audit.logger";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminAuthService } from "./admin-auth.service";
import { AdminGuard } from "./admin.guard";
import { deriveAdminJwtSecret } from "./admin-config";
import { ADMIN_COOKIE_NAME, ADMIN_CSRF_HEADER, buildAdminCookieOptions } from "./admin-session";
import { ADMIN_JWT, ADMIN_USER_IDS, createAdminJwtService } from "./admin-tokens";

const ADMIN_ID = "0b6f3c1e-2a4d-4e5f-9a7b-1c2d3e4f5a6b";
const COACH_ID = "7c8d9e0f-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const PASSWORD = "motdepasse-admin-123";

// Routes sondes : une route admin non-sûre (CSRF) et une route JwtAuthGuard
// classique (preuve qu'une session admin n'ouvre RIEN côté Athlete/Coach).
@Controller()
class ProbeController {
  @Patch("admin/probe")
  @UseGuards(AdminGuard)
  adminWrite(@Req() req: Request) {
    return { userId: req.admin!.userId };
  }

  @Get("notifications")
  @UseGuards(JwtAuthGuard)
  regular(@Req() req: Request) {
    return { sub: req.user!.sub };
  }
}

function cookiesOf(res: request.Response): string[] {
  return (res.headers["set-cookie"] ?? []) as unknown as string[];
}

function adminCookieOf(res: request.Response): string | undefined {
  return cookiesOf(res).find((c) => c.startsWith(`${ADMIN_COOKIE_NAME}=`));
}

describe("Authentification EkvaraAdmin (HTTP, guards réels)", () => {
  let app: INestApplication;
  let adminJwt: JwtService;
  let users: Record<string, { id: string; email: string; nom: string; prenom: string; password_hash: string | null }>;
  let audit: { record: jest.Mock; denied: jest.Mock };
  let adminIds: Set<string>;

  beforeAll(async () => {
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    users = {
      "admin@ekvara.fr": { id: ADMIN_ID, email: "admin@ekvara.fr", nom: "Admin", prenom: "Ekvara", password_hash: hash },
      "coach@ekvara.fr": { id: COACH_ID, email: "coach@ekvara.fr", nom: "Coach", prenom: "Sophie", password_hash: hash },
    };
  });

  beforeEach(async () => {
    adminJwt = createAdminJwtService(TEST_JWT_SECRET);
    adminIds = new Set([ADMIN_ID]);
    audit = { record: jest.fn(), denied: jest.fn() };
    const prisma = {
      app_user: {
        findUnique: jest.fn(async ({ where, select }: { where: { email?: string; id?: string }; select: Record<string, boolean> }) => {
          const user = Object.values(users).find((u) => u.email === where.email || u.id === where.id);
          if (!user) return null;
          return Object.fromEntries(Object.keys(select).map((key) => [key, user[key as keyof typeof user]]));
        }),
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [testJwtModule(), ThrottlerModule.forRoot([{ ttl: 60_000, limit: 5 }])],
      controllers: [AdminAuthController, ProbeController],
      providers: [
        AdminAuthService,
        AdminGuard,
        JwtAuthGuard,
        { provide: AdminAuditLogger, useValue: audit },
        { provide: PrismaService, useValue: prisma },
        { provide: ADMIN_JWT, useValue: adminJwt },
        { provide: ADMIN_USER_IDS, useValue: adminIds },
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

  const login = (email: string, password = PASSWORD) =>
    request(app.getHttpServer()).post("/admin/auth/login").send({ email, password });

  async function loggedIn() {
    const res = await login("admin@ekvara.fr").expect(200);
    const cookie = adminCookieOf(res)!.split(";")[0];
    return { cookie, csrf: res.body.csrfToken as string };
  }

  describe("POST /admin/auth/login", () => {
    it("administrateur : 200, cookie HttpOnly SameSite=Strict, jeton CSRF dans le corps, jamais le JWT", async () => {
      const res = await login("admin@ekvara.fr").expect(200);

      const cookie = adminCookieOf(res);
      expect(cookie).toBeDefined();
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\//);
      expect(res.body.user).toEqual({ id: ADMIN_ID, email: "admin@ekvara.fr", nom: "Admin", prenom: "Ekvara" });
      expect(typeof res.body.csrfToken).toBe("string");
      expect(res.body.csrfToken.length).toBeGreaterThanOrEqual(40);
      expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(JSON.stringify(res.body)).not.toContain(cookie!.split(";")[0].split("=")[1]);
      expect(JSON.stringify(res.body)).not.toContain("password");
      expect(audit.record).toHaveBeenCalledWith("admin.login.success", { userId: ADMIN_ID });
    });

    it("email insensible à la casse, comme /auth/login", async () => {
      await login("ADMIN@Ekvara.fr").expect(200);
    });

    it("compte valide mais NON administrateur : 401 générique, aucun cookie, éligibilité vérifiée avant toute session", async () => {
      const sign = jest.spyOn(adminJwt, "sign");
      const res = await login("coach@ekvara.fr").expect(401);

      expect(res.body.message).toBe("Identifiants invalides ou accès non autorisé");
      expect(cookiesOf(res)).toHaveLength(0);
      expect(sign).not.toHaveBeenCalled();
      expect(audit.denied).toHaveBeenCalledWith("admin.login.denied", { userId: COACH_ID, reason: "not_admin" });
    });

    it("mot de passe faux et email inconnu : même 401 générique, aucun cookie", async () => {
      const wrong = await login("admin@ekvara.fr", "mauvais").expect(401);
      const unknown = await login("inconnu@ekvara.fr").expect(401);

      expect(wrong.body.message).toBe(unknown.body.message);
      expect(cookiesOf(wrong)).toHaveLength(0);
      expect(cookiesOf(unknown)).toHaveLength(0);
    });

    it("aucun administrateur configuré : personne ne peut se connecter", async () => {
      adminIds.clear();
      await login("admin@ekvara.fr").expect(401);
    });

    it("validation serveur : email invalide, champ manquant ou champ inconnu -> 400", async () => {
      await request(app.getHttpServer()).post("/admin/auth/login").send({ email: "pas-un-email", password: "x" }).expect(400);
      await request(app.getHttpServer()).post("/admin/auth/login").send({ email: "admin@ekvara.fr" }).expect(400);
      await request(app.getHttpServer())
        .post("/admin/auth/login")
        .send({ email: "admin@ekvara.fr", password: PASSWORD, isAdmin: true })
        .expect(400);
    });

    it("throttling : la 6e tentative dans la minute -> 429", async () => {
      for (let i = 0; i < 5; i++) {
        await login("admin@ekvara.fr", "mauvais").expect(401);
      }
      await login("admin@ekvara.fr").expect(429);
    });
  });

  describe("AdminGuard (GET /admin/auth/session)", () => {
    const session = () => request(app.getHttpServer()).get("/admin/auth/session");

    it("session valide -> 200 avec le même jeton CSRF", async () => {
      const { cookie, csrf } = await loggedIn();
      const res = await session().set("Cookie", cookie).expect(200);
      expect(res.body.user.id).toBe(ADMIN_ID);
      expect(res.body.csrfToken).toBe(csrf);
    });

    it("sans cookie -> 401", async () => {
      await session().expect(401);
    });

    it("cookie Athlete ou Coach valide (JWT classique) -> 401 : jamais lu comme session admin", async () => {
      const token = signTestToken({ sub: ADMIN_ID, coachId: "c" });
      await session().set("Cookie", authCookieHeader(token, "coach")).expect(401);
      await session().set("Cookie", authCookieHeader(token, "athlete")).expect(401);
    });

    it("JWT classique copié dans le cookie admin -> 401 (secret différent)", async () => {
      const token = signTestToken({ sub: ADMIN_ID });
      await session().set("Cookie", `${ADMIN_COOKIE_NAME}=${token}`).expect(401);
    });

    it("bon secret admin mais mauvaise audience -> 401", async () => {
      const forged = new JwtService({ secret: deriveAdminJwtSecret(TEST_JWT_SECRET) }).sign({ sub: ADMIN_ID, csrf: "x" });
      await session().set("Cookie", `${ADMIN_COOKIE_NAME}=${forged}`).expect(401);
    });

    it("session expirée -> 401", async () => {
      const expired = adminJwt.sign({ sub: ADMIN_ID, csrf: "x" }, { expiresIn: -10 });
      await session().set("Cookie", `${ADMIN_COOKIE_NAME}=${expired}`).expect(401);
    });

    it("administrateur retiré de ADMIN_USER_IDS après connexion -> 403 à la requête suivante", async () => {
      const { cookie } = await loggedIn();
      adminIds.delete(ADMIN_ID);
      await session().set("Cookie", cookie).expect(403);
      expect(audit.denied).toHaveBeenCalledWith("admin.access.denied", expect.objectContaining({ userId: ADMIN_ID, reason: "not_admin" }));
    });
  });

  describe("CSRF sur les méthodes non-sûres", () => {
    it("PATCH admin sans en-tête CSRF -> 403", async () => {
      const { cookie } = await loggedIn();
      await request(app.getHttpServer()).patch("/admin/probe").set("Cookie", cookie).expect(403);
    });

    it("PATCH admin avec un jeton CSRF d'une autre session -> 403", async () => {
      const { cookie } = await loggedIn();
      const other = await loggedIn();
      await request(app.getHttpServer()).patch("/admin/probe").set("Cookie", cookie).set(ADMIN_CSRF_HEADER, other.csrf).expect(403);
    });

    it("PATCH admin avec le jeton CSRF de la session -> 200", async () => {
      const { cookie, csrf } = await loggedIn();
      const res = await request(app.getHttpServer()).patch("/admin/probe").set("Cookie", cookie).set(ADMIN_CSRF_HEADER, csrf).expect(200);
      expect(res.body).toEqual({ userId: ADMIN_ID });
    });

    it("jeton CSRF seul, sans cookie de session -> 401", async () => {
      const { csrf } = await loggedIn();
      await request(app.getHttpServer()).patch("/admin/probe").set(ADMIN_CSRF_HEADER, csrf).expect(401);
    });
  });

  describe("POST /admin/auth/logout", () => {
    it("sans jeton CSRF -> 403, cookie conservé", async () => {
      const { cookie } = await loggedIn();
      const res = await request(app.getHttpServer()).post("/admin/auth/logout").set("Cookie", cookie).expect(403);
      expect(adminCookieOf(res)).toBeUndefined();
    });

    it("avec jeton CSRF -> 200 et cookie admin effacé", async () => {
      const { cookie, csrf } = await loggedIn();
      const res = await request(app.getHttpServer())
        .post("/admin/auth/logout")
        .set("Cookie", cookie)
        .set(ADMIN_CSRF_HEADER, csrf)
        .expect(200);
      expect(adminCookieOf(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(audit.record).toHaveBeenCalledWith("admin.logout", { userId: ADMIN_ID });
    });
  });

  describe("Isolation des sessions Athlete / Coach", () => {
    it("une session admin n'authentifie aucune route Athlete/Coach (JwtAuthGuard)", async () => {
      const { cookie } = await loggedIn();
      const token = cookie.split("=")[1];
      await request(app.getHttpServer()).get("/notifications").set("Cookie", cookie).expect(401);
      await request(app.getHttpServer()).get("/notifications").set("Cookie", `${AUTH_COOKIE_NAMES.athlete}=${token}`).expect(401);
    });

    it("les sessions Athlete/Coach existantes fonctionnent toujours à côté", async () => {
      const token = signTestToken({ sub: "u-kais", athleteId: "a" });
      await request(app.getHttpServer()).get("/notifications").set("Cookie", authCookieHeader(token)).expect(200);
    });
  });
});

describe("Options du cookie admin", () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("Secure en production, HttpOnly + SameSite=Strict toujours, durée 8 h", () => {
    process.env.NODE_ENV = "production";
    expect(buildAdminCookieOptions()).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict", maxAge: 8 * 3600 * 1000 });
    process.env.NODE_ENV = "development";
    expect(buildAdminCookieOptions()).toMatchObject({ httpOnly: true, secure: false, sameSite: "strict" });
  });
});
