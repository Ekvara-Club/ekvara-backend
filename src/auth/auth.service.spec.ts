import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { AuthService } from "./auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { AthletesService } from "../athletes/athletes.service";
import { InvitationsService } from "../invitations/invitations.service";
import { testJwtModule } from "../test-utils/auth-test.helper";

describe("AuthService", () => {
  let service: AuthService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let athletesService: { createWithinTransaction: jest.Mock; findOne: jest.Mock };
  let invitationsService: { redeem: jest.Mock };
  let jwtService: JwtService;

  const APP_USER_ID = "u-1111-1111-1111-111111111111";
  const ATHLETE_ID = "a-2222-2222-2222-222222222222";
  const COACH_ID = "c-3333-3333-3333-333333333333";
  const CLUB_ID = "cl-4444-4444-4444-444444444444";
  const INVITER_COACH_ID = "c-5555-5555-5555-555555555555";

  beforeEach(async () => {
    prisma = { app_user: { findUnique: jest.fn() } };
    athletesService = { createWithinTransaction: jest.fn(), findOne: jest.fn() };
    invitationsService = { redeem: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: AthletesService, useValue: athletesService },
        { provide: InvitationsService, useValue: invitationsService },
      ],
    }).compile();

    service = module.get(AuthService);
    jwtService = module.get(JwtService);
  });

  describe("register", () => {
    // tx factice partagé par $transaction : vérifie que redeem() et la
    // création coach_athlete/groupe reçoivent bien LE MÊME client que
    // createWithinTransaction (voir ticket §"TRANSACTION REGISTER" — tout
    // doit appartenir à une seule transaction Prisma, jamais plusieurs).
    let tx: { coach_athlete: { create: jest.Mock }; coach_group_athlete: { create: jest.Mock }; app_user: { update: jest.Mock } };

    const REGISTER_DTO = {
      invitationCode: "EKV-ABCD2345",
      email: "Test@Ekvara.fr",
      password: "motdepasse123",
      nom: "Dupont",
      prenom: "Jean",
    acceptPrivacyPolicy: true,
    acceptHealthData: true,
    confirmAgeOrParentalConsent: true,
    };

    beforeEach(() => {
      tx = { coach_athlete: { create: jest.fn() }, coach_group_athlete: { create: jest.fn() }, app_user: { update: jest.fn() } };
      prisma.$transaction = jest.fn((callback: (tx: unknown) => unknown) => callback(tx));
    });

    it("hash réellement le mot de passe (argon2id) avant de le transmettre à AthletesService, avec le clubId dérivé de l'invitation", async () => {
      invitationsService.redeem.mockResolvedValue({
        club_id: CLUB_ID,
        created_by_coach_id: INVITER_COACH_ID,
        assigned_group_id: null,
      });
      athletesService.createWithinTransaction.mockResolvedValue({
        id: ATHLETE_ID,
        app_user: { id: APP_USER_ID, email: "test@ekvara.fr" },
      });

      await service.register(REGISTER_DTO);

      const [usedTx, dto, passwordHash] = athletesService.createWithinTransaction.mock.calls[0];
      expect(usedTx).toBe(tx);
      expect(passwordHash).not.toBe("motdepasse123");
      expect(passwordHash).toMatch(/^\$argon2id\$/);
      await expect(argon2.verify(passwordHash, "motdepasse123")).resolves.toBe(true);
      // email trim + lowercase avant stockage/recherche
      expect(dto.email).toBe("test@ekvara.fr");
      expect(dto.clubId).toBe(CLUB_ID);
    });

    it("revalide et consomme l'invitation avec le tx de la transaction globale (jamais un simple appel /validate)", async () => {
      invitationsService.redeem.mockResolvedValue({
        club_id: CLUB_ID,
        created_by_coach_id: INVITER_COACH_ID,
        assigned_group_id: null,
      });
      athletesService.createWithinTransaction.mockResolvedValue({
        id: ATHLETE_ID,
        app_user: { id: APP_USER_ID },
      });

      await service.register(REGISTER_DTO);

      expect(invitationsService.redeem).toHaveBeenCalledWith(tx, "EKV-ABCD2345");
    });

    it("RGPD : enregistre le consentement (version de la politique + date) dans la même transaction", async () => {
      invitationsService.redeem.mockResolvedValue({ club_id: CLUB_ID, created_by_coach_id: INVITER_COACH_ID, assigned_group_id: null });
      athletesService.createWithinTransaction.mockResolvedValue({ id: ATHLETE_ID, user_id: APP_USER_ID, app_user: { id: APP_USER_ID } });

      await service.register(REGISTER_DTO);

      expect(tx.app_user.update).toHaveBeenCalledWith({
        where: { id: APP_USER_ID },
        data: { consent_version: "2026-10-06", consent_at: expect.any(Date) },
      });
    });

    it("rattache automatiquement l'athlète créé au coach créateur de l'invitation (coach_athlete)", async () => {
      invitationsService.redeem.mockResolvedValue({
        club_id: CLUB_ID,
        created_by_coach_id: INVITER_COACH_ID,
        assigned_group_id: null,
      });
      athletesService.createWithinTransaction.mockResolvedValue({
        id: ATHLETE_ID,
        app_user: { id: APP_USER_ID },
      });

      await service.register(REGISTER_DTO);

      expect(tx.coach_athlete.create).toHaveBeenCalledWith({
        data: { coach_id: INVITER_COACH_ID, athlete_id: ATHLETE_ID },
      });
    });

    it("rejoint le groupe assigné si l'invitation en porte un", async () => {
      const GROUP_ID = "g-6666-6666-6666-666666666666";
      invitationsService.redeem.mockResolvedValue({
        club_id: CLUB_ID,
        created_by_coach_id: INVITER_COACH_ID,
        assigned_group_id: GROUP_ID,
      });
      athletesService.createWithinTransaction.mockResolvedValue({
        id: ATHLETE_ID,
        app_user: { id: APP_USER_ID },
      });

      await service.register(REGISTER_DTO);

      expect(tx.coach_group_athlete.create).toHaveBeenCalledWith({
        data: { group_id: GROUP_ID, athlete_id: ATHLETE_ID },
      });
    });

    it("ne rejoint aucun groupe si l'invitation n'en porte pas (jamais obligatoire)", async () => {
      invitationsService.redeem.mockResolvedValue({
        club_id: CLUB_ID,
        created_by_coach_id: INVITER_COACH_ID,
        assigned_group_id: null,
      });
      athletesService.createWithinTransaction.mockResolvedValue({
        id: ATHLETE_ID,
        app_user: { id: APP_USER_ID },
      });

      await service.register(REGISTER_DTO);

      expect(tx.coach_group_athlete.create).not.toHaveBeenCalled();
    });

    it("retourne un token dont le payload contient sub=app_user.id et athleteId=athlete.id", async () => {
      invitationsService.redeem.mockResolvedValue({
        club_id: CLUB_ID,
        created_by_coach_id: INVITER_COACH_ID,
        assigned_group_id: null,
      });
      athletesService.createWithinTransaction.mockResolvedValue({
        id: ATHLETE_ID,
        app_user: { id: APP_USER_ID, email: "test@ekvara.fr" },
      });

      const { token, athlete } = await service.register(REGISTER_DTO);

      expect(athlete.id).toBe(ATHLETE_ID);
      const decoded = jwtService.verify(token);
      expect(decoded.sub).toBe(APP_USER_ID);
      expect(decoded.athleteId).toBe(ATHLETE_ID);
      // Payload minimal : ni email, ni nom, ni prénom.
      expect(decoded.email).toBeUndefined();
      expect(decoded.nom).toBeUndefined();
    });

    it("code d'invitation invalide -> l'erreur d'InvitationsService.redeem est propagée telle quelle, AthletesService jamais appelé", async () => {
      invitationsService.redeem.mockRejectedValue(new NotFoundException("Ce code d'invitation n'est pas valide."));

      await expect(service.register(REGISTER_DTO)).rejects.toBeInstanceOf(NotFoundException);
      expect(athletesService.createWithinTransaction).not.toHaveBeenCalled();
    });

    it("propage ConflictException (email déjà utilisé) sans la remplacer par un message générique", async () => {
      invitationsService.redeem.mockResolvedValue({
        club_id: CLUB_ID,
        created_by_coach_id: INVITER_COACH_ID,
        assigned_group_id: null,
      });
      athletesService.createWithinTransaction.mockRejectedValue(
        new ConflictException("Cet email est déjà utilisé"),
      );

      await expect(service.register(REGISTER_DTO)).rejects.toThrow("Cet email est déjà utilisé");
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

    it("compte sans athlete NI coach_profile -> UnauthorizedException (compte orphelin)", async () => {
      const passwordHash = await argon2.hash("bon-mot-de-passe", { type: argon2.argon2id });
      prisma.app_user.findUnique.mockResolvedValue({
        id: APP_USER_ID,
        password_hash: passwordHash,
        athlete: null,
        coach_profile: null,
      });

      await expect(
        service.login({ email: "test@ekvara.fr", password: "bon-mot-de-passe" }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("coach-only -> token {sub, coachId} sans athleteId, athlete=null dans la réponse", async () => {
      const passwordHash = await argon2.hash("bon-mot-de-passe", { type: argon2.argon2id });
      prisma.app_user.findUnique.mockResolvedValue({
        id: APP_USER_ID,
        password_hash: passwordHash,
        athlete: null,
        coach_profile: { id: COACH_ID },
      });

      const { token, athlete } = await service.login({
        email: "test@ekvara.fr",
        password: "bon-mot-de-passe",
      });

      expect(athlete).toBeNull();
      expect(athletesService.findOne).not.toHaveBeenCalled();
      const decoded = jwtService.verify(token);
      expect(decoded.sub).toBe(APP_USER_ID);
      expect(decoded.coachId).toBe(COACH_ID);
      expect(decoded.athleteId).toBeUndefined();
    });

    it("utilisateur hybride (athlete + coach_profile) -> token {sub, athleteId, coachId}", async () => {
      const passwordHash = await argon2.hash("bon-mot-de-passe", { type: argon2.argon2id });
      prisma.app_user.findUnique.mockResolvedValue({
        id: APP_USER_ID,
        password_hash: passwordHash,
        athlete: { id: ATHLETE_ID },
        coach_profile: { id: COACH_ID },
      });
      athletesService.findOne.mockResolvedValue({ id: ATHLETE_ID });

      const { token, athlete } = await service.login({
        email: "test@ekvara.fr",
        password: "bon-mot-de-passe",
      });

      expect(athlete).toEqual({ id: ATHLETE_ID });
      const decoded = jwtService.verify(token);
      expect(decoded.sub).toBe(APP_USER_ID);
      expect(decoded.athleteId).toBe(ATHLETE_ID);
      expect(decoded.coachId).toBe(COACH_ID);
    });
  });

  describe("getMe", () => {
    it("délègue à AthletesService.findOne", async () => {
      athletesService.findOne.mockResolvedValue({ id: ATHLETE_ID });

      const result = await service.getMe(ATHLETE_ID);

      expect(result).toEqual({ id: ATHLETE_ID });
      expect(athletesService.findOne).toHaveBeenCalledWith(ATHLETE_ID);
    });

    it("sans athleteId (coach-only) -> UnauthorizedException, sans appeler AthletesService.findOne(undefined)", () => {
      // getMe() est synchrone : elle lève directement, pas de Promise rejetée.
      expect(() => service.getMe(undefined)).toThrow(UnauthorizedException);
      expect(athletesService.findOne).not.toHaveBeenCalled();
    });
  });
});
