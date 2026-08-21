import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, INestApplication, UnauthorizedException, ValidationPipe } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { AUTH_COOKIE_NAME } from "./auth.cookie";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

describe("AuthController (HTTP)", () => {
  let app: INestApplication;
  let service: {
    register: jest.Mock;
    login: jest.Mock;
    getMe: jest.Mock;
    getTokenRemainingMs: jest.Mock;
  };

  const ATHLETE_ID = "240fe60f-6e74-46ea-87a0-45872bd1f4fe";

  beforeEach(async () => {
    service = {
      register: jest.fn(),
      login: jest.fn(),
      getMe: jest.fn(),
      getTokenRemainingMs: jest.fn().mockReturnValue(3_600_000),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule(), ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: service }, JwtAuthGuard],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("POST /auth/register", () => {
    it("valide -> 201, pas de password_hash exposé, cookie HttpOnly posé", async () => {
      service.register.mockResolvedValue({
        athlete: { id: ATHLETE_ID, app_user: { id: "u-1", email: "test@ekvara.fr" } },
        token: "signed.jwt.token",
      });

      const res = await request(app.getHttpServer())
        .post("/auth/register")
        .send({ email: "test@ekvara.fr", password: "motdepasse123", nom: "Dupont", prenom: "Jean" })
        .expect(201);

      expect(res.body).not.toHaveProperty("password_hash");
      expect(JSON.stringify(res.body)).not.toMatch(/password/i);

      const setCookie = res.headers["set-cookie"];
      expect(setCookie).toBeDefined();
      const authCookie = (setCookie as unknown as string[]).find((c) => c.startsWith(AUTH_COOKIE_NAME));
      expect(authCookie).toBeDefined();
      expect(authCookie).toMatch(/HttpOnly/i);
      expect(authCookie).toMatch(/SameSite=Lax/i);
    });

    it("email invalide -> 400", async () => {
      await request(app.getHttpServer())
        .post("/auth/register")
        .send({ email: "pas-un-email", password: "motdepasse123", nom: "Dupont", prenom: "Jean" })
        .expect(400);
      expect(service.register).not.toHaveBeenCalled();
    });

    it("password trop court -> 400", async () => {
      await request(app.getHttpServer())
        .post("/auth/register")
        .send({ email: "test@ekvara.fr", password: "court", nom: "Dupont", prenom: "Jean" })
        .expect(400);
      expect(service.register).not.toHaveBeenCalled();
    });

    it("email déjà utilisé -> 409 (délégué au service)", async () => {
      service.register.mockRejectedValue(new ConflictException("Cet email est déjà utilisé"));

      await request(app.getHttpServer())
        .post("/auth/register")
        .send({ email: "test@ekvara.fr", password: "motdepasse123", nom: "Dupont", prenom: "Jean" })
        .expect(409);
    });
  });

  describe("POST /auth/login", () => {
    it("valide -> 200, cookie posé", async () => {
      service.login.mockResolvedValue({
        athlete: { id: ATHLETE_ID },
        token: "signed.jwt.token",
      });

      const res = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: "test@ekvara.fr", password: "motdepasse123" })
        .expect(200);

      const setCookie = res.headers["set-cookie"];
      expect(setCookie).toBeDefined();
      expect((setCookie as unknown as string[])[0]).toMatch(new RegExp(`^${AUTH_COOKIE_NAME}=`));
    });

    it("mauvais mot de passe -> 401", async () => {
      service.login.mockRejectedValue(new UnauthorizedException("Email ou mot de passe incorrect"));

      const res = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: "test@ekvara.fr", password: "mauvais" })
        .expect(401);

      expect(res.body.message).toBe("Email ou mot de passe incorrect");
    });

    it("utilisateur absent -> 401 avec message identique à 'mauvais mot de passe'", async () => {
      service.login.mockRejectedValue(new UnauthorizedException("Email ou mot de passe incorrect"));

      const res = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: "absent@ekvara.fr", password: "x" })
        .expect(401);

      expect(res.body.message).toBe("Email ou mot de passe incorrect");
    });
  });

  describe("POST /auth/logout", () => {
    it("efface le cookie", async () => {
      const res = await request(app.getHttpServer()).post("/auth/logout").expect(200);

      const setCookie = res.headers["set-cookie"] as unknown as string[];
      expect(setCookie).toBeDefined();
      const cleared = setCookie.find((c) => c.startsWith(AUTH_COOKIE_NAME));
      expect(cleared).toBeDefined();
      // Express clearCookie fixe une date d'expiration passée.
      expect(cleared).toMatch(/Expires=/i);
    });
  });

  describe("GET /auth/me", () => {
    it("authentifié -> 200", async () => {
      service.getMe.mockResolvedValue({ id: ATHLETE_ID });
      const token = signTestToken({ sub: "u-1", athleteId: ATHLETE_ID });

      const res = await request(app.getHttpServer())
        .get("/auth/me")
        .set("Cookie", authCookieHeader(token))
        .expect(200);

      expect(res.body).toEqual({ id: ATHLETE_ID });
      expect(service.getMe).toHaveBeenCalledWith(ATHLETE_ID);
    });

    it("sans cookie -> 401", async () => {
      await request(app.getHttpServer()).get("/auth/me").expect(401);
    });

    it("JWT invalide (signature incorrecte) -> 401", async () => {
      await request(app.getHttpServer())
        .get("/auth/me")
        .set("Cookie", `${AUTH_COOKIE_NAME}=ceci-nest-pas-un-jwt-valide`)
        .expect(401);
    });

    it("JWT expiré -> 401", async () => {
      const expiredToken = signTestToken({ sub: "u-1", athleteId: ATHLETE_ID }, "-1s");

      await request(app.getHttpServer())
        .get("/auth/me")
        .set("Cookie", authCookieHeader(expiredToken))
        .expect(401);
    });

    it("après suppression du cookie côté client, une requête sans cookie -> 401 (le JWT n'est pas révoqué côté serveur)", async () => {
      // Illustre explicitement que logout n'invalide pas un token déjà émis :
      // un token signé avant logout resterait valide s'il était rejoué avec
      // son propre cookie. Ici on vérifie seulement le cas normal (client
      // sans cookie après logout).
      await request(app.getHttpServer()).post("/auth/logout").expect(200);
      await request(app.getHttpServer()).get("/auth/me").expect(401);
    });
  });
});
