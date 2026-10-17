import "dotenv/config";
import * as argon2 from "argon2";
import { INestApplication, UnauthorizedException, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request = require("supertest");
import { PrismaService } from "../prisma/prisma.service";
import { describeOnTestDatabase } from "../test-utils/test-database";
import { AdminAuditLogger } from "./admin-audit.logger";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminAuthService } from "./admin-auth.service";
import { AdminGuard } from "./admin.guard";
import { ADMIN_LOGIN_LIMITS, ADMIN_THROTTLE_SECRET, AdminLoginThrottle } from "./admin-login-throttle";
import { ADMIN_CSRF_HEADER, ADMIN_COOKIE_NAME } from "./admin-session";
import { AdminSessionsRepository } from "./admin-sessions.repository";
import { ADMIN_JWT, ADMIN_USER_IDS, createAdminJwtService } from "./admin-tokens";

// Sessions admin et limitation des connexions contre un vrai Postgres,
// UNIQUEMENT sur la base de test isolée (npm run test:testdb), ignoré sinon.
// Chaque « instance » est une application Nest DISTINCTE avec son propre
// PrismaService (comme deux fonctions Vercel) : seule la base est partagée.
// Comptes jetables (sessions supprimées en cascade) et compteurs de ce
// passage supprimés en afterAll.
describeOnTestDatabase("Sessions et connexion EkvaraAdmin (intégration Postgres, base de test)", () => {
  const runId = Date.now();
  const password = "motdepasse-integration";
  const adminEmail = `admin-${runId}@test.ekvara.fr`;
  const otherEmail = `other-${runId}@test.ekvara.fr`;
  let prisma: PrismaService;
  let adminId: string;
  let otherId: string;
  let runStart: Date;
  const apps: INestApplication[] = [];
  let secretSeq = 0;

  beforeAll(async () => {
    prisma = new PrismaService();
    runStart = (await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`)[0].now;
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const admin = await prisma.app_user.create({ data: { email: adminEmail, password_hash: passwordHash, nom: "Admin", prenom: "Test" } });
    const other = await prisma.app_user.create({ data: { email: otherEmail, password_hash: passwordHash, nom: "Other", prenom: "Test" } });
    adminId = admin.id;
    otherId = other.id;
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  afterAll(async () => {
    await prisma.app_user.deleteMany({ where: { id: { in: [adminId, otherId] } } });
    await prisma.$executeRaw`DELETE FROM admin_login_attempt WHERE window_start >= ${runStart}`;
    await prisma.$disconnect();
  });

  // Secret de limitation propre à chaque test : compteurs indépendants entre
  // tests, mais PARTAGÉS entre les instances d'un même test.
  const freshSecret = () => `throttle-${runId}-${secretSeq++}`;

  // Une instance = une application Nest + son propre client Prisma.
  async function instance(throttleSecret: string, options: { trustProxy?: boolean } = {}) {
    const ownPrisma = new PrismaService();
    const audit = new AdminAuditLogger();
    jest.spyOn(audit, "record").mockImplementation(() => undefined);
    jest.spyOn(audit, "denied").mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminAuthController],
      providers: [
        AdminAuthService,
        AdminGuard,
        AdminSessionsRepository,
        AdminLoginThrottle,
        { provide: PrismaService, useValue: ownPrisma },
        { provide: AdminAuditLogger, useValue: audit },
        { provide: ADMIN_JWT, useValue: createAdminJwtService("integration-secret") },
        { provide: ADMIN_USER_IDS, useValue: new Set([adminId]) },
        { provide: ADMIN_THROTTLE_SECRET, useValue: throttleSecret },
      ],
    }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>();
    if (options.trustProxy) app.set("trust proxy", true);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
    apps.push(app);
    const http = () => request(app.getHttpServer());
    return {
      http,
      login: (email: string, pass = password, ip?: string) => {
        const req = http().post("/admin/auth/login");
        if (ip) req.set("X-Forwarded-For", ip);
        return req.send({ email, password: pass });
      },
      close: async () => {
        await app.close();
        await ownPrisma.$disconnect();
      },
    };
  }

  const cookieOf = (res: request.Response) =>
    ((res.headers["set-cookie"] ?? []) as unknown as string[]).find((c) => c.startsWith(`${ADMIN_COOKIE_NAME}=`))!.split(";")[0];

  describe("sessions serveur (admin_session)", () => {
    it("connexion : une session active créée en base (8 h), app_user inchangé", async () => {
      const a = await instance(freshSecret());
      const before = await prisma.app_user.findUniqueOrThrow({ where: { id: adminId } });
      const res = await a.login(adminEmail.toUpperCase()).expect(200);
      const after = await prisma.app_user.findUniqueOrThrow({ where: { id: adminId } });

      expect(after).toEqual(before);
      const rows = await prisma.admin_session.findMany({ where: { app_user_id: adminId, revoked_at: null } });
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const latest = rows.sort((x, y) => y.created_at.getTime() - x.created_at.getTime())[0];
      expect(latest.expires_at.getTime() - Date.now()).toBeGreaterThan(7.9 * 3600_000);
      expect(new Date(res.body.expiresAt).getTime()).toBeLessThanOrEqual(latest.expires_at.getTime() + 1000);
      await a.close();
    });

    it("compte non administrateur ou mauvais mot de passe : 401, aucune session créée", async () => {
      const a = await instance(freshSecret());
      await a.login(otherEmail).expect(401);
      await a.login(adminEmail, "faux").expect(401);
      expect(await prisma.admin_session.count({ where: { app_user_id: otherId } })).toBe(0);
      await a.close();
    });

    it("déconnexion sur l'instance A : le JWT copié est refusé IMMÉDIATEMENT sur A et sur B", async () => {
      const secret = freshSecret();
      const a = await instance(secret);
      const b = await instance(secret);
      const res = await a.login(adminEmail).expect(200);
      const cookie = cookieOf(res);
      const csrf = res.body.csrfToken as string;

      await b.http().get("/admin/auth/session").set("Cookie", cookie).expect(200);
      await a.http().post("/admin/auth/logout").set("Cookie", cookie).set(ADMIN_CSRF_HEADER, csrf).expect(200);

      await b.http().get("/admin/auth/session").set("Cookie", cookie).expect(401);
      await a.http().get("/admin/auth/session").set("Cookie", cookie).expect(401);
      const revoked = await prisma.admin_session.findMany({ where: { app_user_id: adminId, revoked_at: { not: null } } });
      expect(revoked.length).toBeGreaterThanOrEqual(1);
      await a.close();
      await b.close();
    });

    it("session expirée en base : refusée même si le JWT est encore valide", async () => {
      const a = await instance(freshSecret());
      const res = await a.login(adminEmail).expect(200);
      const cookie = cookieOf(res);
      await a.http().get("/admin/auth/session").set("Cookie", cookie).expect(200);
      const sid = JSON.parse(Buffer.from(cookie.split("=")[1].split(".")[1], "base64url").toString()).sid as string;
      await prisma.admin_session.update({ where: { id: sid }, data: { expires_at: new Date(Date.now() - 1000) } });
      await a.http().get("/admin/auth/session").set("Cookie", cookie).expect(401);
      await a.close();
    });

    it("purge : les sessions expirées depuis plus d'un jour sont supprimées à la connexion suivante", async () => {
      const stale = await prisma.admin_session.create({
        data: { app_user_id: adminId, expires_at: new Date(Date.now() - 2 * 24 * 3600_000) },
      });
      const a = await instance(freshSecret());
      await a.login(adminEmail).expect(200);
      expect(await prisma.admin_session.findUnique({ where: { id: stale.id } })).toBeNull();
      await a.close();
    });

    it("compte supprimé : getSession -> 401", async () => {
      const service = new AdminAuthService(
        prisma,
        createAdminJwtService("integration-secret"),
        new Set(),
        new AdminSessionsRepository(prisma),
        new AdminLoginThrottle(prisma, freshSecret()),
        new AdminAuditLogger(),
      );
      await expect(
        service.getSession({ userId: "00000000-0000-4000-8000-000000000000", sessionId: "x", csrfToken: "x", expiresAt: new Date() }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe("limitation des connexions partagée entre instances (admin_login_attempt)", () => {
    it("par IP : 3 tentatives sur A + 2 sur B, la 6e est refusée (429) sur l'une comme sur l'autre", async () => {
      const secret = freshSecret();
      const a = await instance(secret);
      const b = await instance(secret);
      for (const inst of [a, a, a, b, b]) await inst.login(adminEmail, "faux").expect(401);
      const res = await b.login(adminEmail).expect(429);
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
      await a.login(adminEmail).expect(429);
      await a.close();
      await b.close();
    });

    it("par compte : 10 échecs depuis 10 IP différentes (A et B) -> le compte est verrouillé, même avec le bon mot de passe", async () => {
      const secret = freshSecret();
      const a = await instance(secret, { trustProxy: true });
      const b = await instance(secret, { trustProxy: true });
      for (let i = 0; i < ADMIN_LOGIN_LIMITS.account.limit; i++) {
        await (i % 2 === 0 ? a : b).login(adminEmail, "faux", `203.0.113.${i + 1}`).expect(401);
      }
      await a.login(adminEmail, password, "198.51.100.7").expect(429);
      // Un autre compte n'est pas affecté.
      await b.login(otherEmail, "faux", "198.51.100.8").expect(401);
      await a.close();
      await b.close();
    });

    it("par compte : une connexion réussie remet le compteur d'échecs à zéro", async () => {
      const secret = freshSecret();
      const a = await instance(secret, { trustProxy: true });
      for (let i = 0; i < 3; i++) await a.login(adminEmail, "faux", `192.0.2.${i + 1}`).expect(401);
      await a.login(adminEmail, password, "192.0.2.50").expect(200);
      const throttle = new AdminLoginThrottle(prisma, secret);
      expect((await throttle.peek(throttle.key("account", adminEmail), ADMIN_LOGIN_LIMITS.account.windowSeconds)).hits).toBe(0);
      await a.close();
    });

    it("sans trust proxy (TRUST_PROXY absent) : un X-Forwarded-For falsifié ne contourne pas la limite par IP", async () => {
      const a = await instance(freshSecret());
      for (let i = 0; i < ADMIN_LOGIN_LIMITS.ip.limit; i++) await a.login(otherEmail, "faux", `10.0.0.${i + 1}`).expect(401);
      await a.login(otherEmail, "faux", "10.0.0.99").expect(429);
      await a.close();
    });

    it("incréments concurrents depuis deux clients Prisma : aucun compteur perdu", async () => {
      const secret = freshSecret();
      const other = new PrismaService();
      const t1 = new AdminLoginThrottle(prisma, secret);
      const t2 = new AdminLoginThrottle(other, secret);
      const key = t1.key("ip", `concurrence-${runId}`);
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? t1 : t2).hit(key, 60)));
      expect(results.map((r) => r.hits).sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      await other.$disconnect();
    });

    it("fenêtre écoulée : le compteur repart à 1", async () => {
      const throttle = new AdminLoginThrottle(prisma, freshSecret());
      const key = throttle.key("ip", `fenetre-${runId}`);
      await throttle.hit(key, 60);
      await throttle.hit(key, 60);
      await prisma.$executeRaw`UPDATE admin_login_attempt SET window_start = now() - interval '2 minutes' WHERE key = ${key}`;
      expect((await throttle.hit(key, 60)).hits).toBe(1);
    });

    it("clés non réversibles : ni l'IP ni l'adresse e-mail ne sont stockées en clair", async () => {
      const rows = await prisma.$queryRaw<{ key: string }[]>`SELECT key FROM admin_login_attempt WHERE window_start >= ${runStart}`;
      expect(rows.length).toBeGreaterThan(0);
      for (const { key } of rows) {
        expect(key).toMatch(/^(ip|account):[0-9a-f]{64}$/);
        expect(key).not.toContain("@");
        expect(key).not.toContain("127.0.0.1");
      }
    });
  });
});
