import { Test, TestingModule } from "@nestjs/testing";
import { UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { AuthService } from "./auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { AthletesService } from "../athletes/athletes.service";
import { testJwtModule } from "../test-utils/auth-test.helper";

describe("AuthService", () => {
  let service: AuthService;
  let prisma: { app_user: { findUnique: jest.Mock } };
  let athletesService: { create: jest.Mock; findOne: jest.Mock };
  let jwtService: JwtService;

  const APP_USER_ID = "u-1111-1111-1111-111111111111";
  const ATHLETE_ID = "a-2222-2222-2222-222222222222";

  beforeEach(async () => {
    prisma = { app_user: { findUnique: jest.fn() } };
    athletesService = { create: jest.fn(), findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: AthletesService, useValue: athletesService },
      ],
    }).compile();

    service = module.get(AuthService);
    jwtService = module.get(JwtService);
  });

  describe("register", () => {
    it("hash réellement le mot de passe (argon2id) avant de le transmettre à AthletesService", async () => {
      athletesService.create.mockResolvedValue({
        id: ATHLETE_ID,
        app_user: { id: APP_USER_ID, email: "test@ekvara.fr" },
      });

      await service.register({
        email: "Test@Ekvara.fr",
        password: "motdepasse123",
        nom: "Dupont",
        prenom: "Jean",
      });

      const [dto, passwordHash] = athletesService.create.mock.calls[0];
      expect(passwordHash).not.toBe("motdepasse123");
      expect(passwordHash).toMatch(/^\$argon2id\$/);
      await expect(argon2.verify(passwordHash, "motdepasse123")).resolves.toBe(true);
      // email trim + lowercase avant stockage/recherche
      expect(dto.email).toBe("test@ekvara.fr");
    });

    it("retourne un token dont le payload contient sub=app_user.id et athleteId=athlete.id", async () => {
      athletesService.create.mockResolvedValue({
        id: ATHLETE_ID,
        app_user: { id: APP_USER_ID, email: "test@ekvara.fr" },
      });

      const { token, athlete } = await service.register({
        email: "test@ekvara.fr",
        password: "motdepasse123",
        nom: "Dupont",
        prenom: "Jean",
      });

      expect(athlete.id).toBe(ATHLETE_ID);
      const decoded = jwtService.verify(token);
      expect(decoded.sub).toBe(APP_USER_ID);
      expect(decoded.athleteId).toBe(ATHLETE_ID);
      // Payload minimal : ni email, ni nom, ni prénom.
      expect(decoded.email).toBeUndefined();
      expect(decoded.nom).toBeUndefined();
    });

    it("propage l'erreur (ex. ConflictException) si AthletesService.create échoue", async () => {
      athletesService.create.mockRejectedValue(new Error("email déjà utilisé"));

      await expect(
        service.register({ email: "test@ekvara.fr", password: "motdepasse123", nom: "D", prenom: "J" }),
      ).rejects.toThrow("email déjà utilisé");
    });
  });

  describe("login", () => {
    it("utilisateur absent -> UnauthorizedException", async () => {
      prisma.app_user.findUnique.mockResolvedValue(null);

      await expect(
        service.login({ email: "absent@ekvara.fr", password: "peu importe" }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("mot de passe incorrect -> UnauthorizedException", async () => {
      const passwordHash = await argon2.hash("bon-mot-de-passe", { type: argon2.argon2id });
      prisma.app_user.findUnique.mockResolvedValue({
        id: APP_USER_ID,
        password_hash: passwordHash,
        athlete: { id: ATHLETE_ID },
      });

      await expect(
        service.login({ email: "test@ekvara.fr", password: "mauvais-mot-de-passe" }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("utilisateur absent et mauvais mot de passe renvoient exactement le même message", async () => {
      prisma.app_user.findUnique.mockResolvedValue(null);
      let absentMessage: string | undefined;
      try {
        await service.login({ email: "absent@ekvara.fr", password: "x" });
      } catch (error) {
        absentMessage = (error as Error).message;
      }

      const passwordHash = await argon2.hash("bon-mot-de-passe", { type: argon2.argon2id });
      prisma.app_user.findUnique.mockResolvedValue({
        id: APP_USER_ID,
        password_hash: passwordHash,
        athlete: { id: ATHLETE_ID },
      });
      let wrongPasswordMessage: string | undefined;
      try {
        await service.login({ email: "test@ekvara.fr", password: "mauvais" });
      } catch (error) {
        wrongPasswordMessage = (error as Error).message;
      }

      expect(absentMessage).toBeDefined();
      expect(absentMessage).toBe(wrongPasswordMessage);
    });

    it("identifiants valides -> token signé + athlète renvoyé par findOne", async () => {
      const passwordHash = await argon2.hash("bon-mot-de-passe", { type: argon2.argon2id });
      prisma.app_user.findUnique.mockResolvedValue({
        id: APP_USER_ID,
        password_hash: passwordHash,
        athlete: { id: ATHLETE_ID },
      });
      athletesService.findOne.mockResolvedValue({ id: ATHLETE_ID });

      const { token, athlete } = await service.login({
        email: "Test@Ekvara.fr",
        password: "bon-mot-de-passe",
      });

      expect(athlete).toEqual({ id: ATHLETE_ID });
      expect(athletesService.findOne).toHaveBeenCalledWith(ATHLETE_ID);
      const decoded = jwtService.verify(token);
      expect(decoded.sub).toBe(APP_USER_ID);
      expect(decoded.athleteId).toBe(ATHLETE_ID);
      // email normalisé avant recherche
      expect(prisma.app_user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: "test@ekvara.fr" } }),
      );
    });
  });

  describe("getMe", () => {
    it("délègue à AthletesService.findOne", async () => {
      athletesService.findOne.mockResolvedValue({ id: ATHLETE_ID });

      const result = await service.getMe(ATHLETE_ID);

      expect(result).toEqual({ id: ATHLETE_ID });
      expect(athletesService.findOne).toHaveBeenCalledWith(ATHLETE_ID);
    });
  });
});
