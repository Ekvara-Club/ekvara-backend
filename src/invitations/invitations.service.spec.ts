import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, ForbiddenException, GoneException, NotFoundException } from "@nestjs/common";
import { InvitationsService } from "./invitations.service";
import { InvitationsRepository } from "./invitations.repository";
import { PrismaService } from "../prisma/prisma.service";
import { normalizeInvitationCode, hashInvitationCode } from "./invitation-code.util";

describe("InvitationsService", () => {
  let service: InvitationsService;
  let repository: {
    create: jest.Mock;
    findForCoach: jest.Mock;
    findOwnership: jest.Mock;
    findById: jest.Mock;
    findByCodeHash: jest.Mock;
    revoke: jest.Mock;
    consumeIfUsable: jest.Mock;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;

  const COACH_ID = "c-1111-1111-1111-111111111111";
  const CLUB_ID = "cl-2222-2222-2222-222222222222";
  const GROUP_ID = "g-3333-3333-3333-333333333333";

  beforeEach(async () => {
    repository = {
      create: jest.fn(),
      findForCoach: jest.fn(),
      findOwnership: jest.fn(),
      findById: jest.fn(),
      findByCodeHash: jest.fn(),
      revoke: jest.fn(),
      consumeIfUsable: jest.fn(),
    };
    prisma = { coach_profile: { findUnique: jest.fn() }, coach_group: { findUnique: jest.fn() } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitationsService,
        { provide: InvitationsRepository, useValue: repository },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(InvitationsService);
  });

  describe("createInvitation", () => {
    it("dérive le club du coach authentifié, jamais d'un paramètre client", async () => {
      prisma.coach_profile.findUnique.mockResolvedValue({ club_id: CLUB_ID });
      repository.create.mockResolvedValue({ id: "inv-1", expires_at: new Date() });

      await service.createInvitation(COACH_ID);

      expect(prisma.coach_profile.findUnique).toHaveBeenCalledWith({
        where: { id: COACH_ID },
        select: { club_id: true },
      });
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ clubId: CLUB_ID, createdByCoachId: COACH_ID }),
      );
    });

    it("coach sans club -> BadRequestException, aucune invitation créée", async () => {
      prisma.coach_profile.findUnique.mockResolvedValue({ club_id: null });

      await expect(service.createInvitation(COACH_ID)).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it("renvoie le code brut UNE SEULE FOIS, jamais stocké tel quel", async () => {
      prisma.coach_profile.findUnique.mockResolvedValue({ club_id: CLUB_ID });
      repository.create.mockResolvedValue({ id: "inv-1", expires_at: new Date() });

      const result = await service.createInvitation(COACH_ID);

      expect(result.code).toMatch(/^EKV-[A-Z0-9]{8}$/);
      const [createArgs] = repository.create.mock.calls[0];
      expect(createArgs.codeHash).not.toBe(result.code);
      expect(createArgs.codeHash).toBe(hashInvitationCode(normalizeInvitationCode(result.code)));
    });

    it("expire dans 7 jours", async () => {
      prisma.coach_profile.findUnique.mockResolvedValue({ club_id: CLUB_ID });
      repository.create.mockResolvedValue({ id: "inv-1", expires_at: new Date() });

      const before = Date.now();
      await service.createInvitation(COACH_ID);
      const [createArgs] = repository.create.mock.calls[0];
      const diffDays = (createArgs.expiresAt.getTime() - before) / (1000 * 60 * 60 * 24);

      expect(diffDays).toBeGreaterThan(6.99);
      expect(diffDays).toBeLessThan(7.01);
    });

    it("groupe appartenant au coach -> accepté et transmis", async () => {
      prisma.coach_profile.findUnique.mockResolvedValue({ club_id: CLUB_ID });
      prisma.coach_group.findUnique.mockResolvedValue({ coach_id: COACH_ID });
      repository.create.mockResolvedValue({ id: "inv-1", expires_at: new Date() });

      await service.createInvitation(COACH_ID, GROUP_ID);

      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ assignedGroupId: GROUP_ID }));
    });

    it("groupe d'un AUTRE coach -> NotFoundException, jamais accepté (isolation multi-coach)", async () => {
      prisma.coach_profile.findUnique.mockResolvedValue({ club_id: CLUB_ID });
      prisma.coach_group.findUnique.mockResolvedValue({ coach_id: "un-autre-coach" });

      await expect(service.createInvitation(COACH_ID, GROUP_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it("groupe inexistant -> NotFoundException", async () => {
      prisma.coach_profile.findUnique.mockResolvedValue({ club_id: CLUB_ID });
      prisma.coach_group.findUnique.mockResolvedValue(null);

      await expect(service.createInvitation(COACH_ID, GROUP_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("listInvitations", () => {
    it("calcule le status active/used/revoked/expired, jamais le code brut", async () => {
      const now = new Date("2026-09-18T12:00:00.000Z");
      jest.useFakeTimers().setSystemTime(now);

      repository.findForCoach.mockResolvedValue([
        { id: "1", created_at: now, expires_at: new Date("2026-09-25T00:00:00Z"), used_at: null, revoked_at: null },
        { id: "2", created_at: now, expires_at: new Date("2026-09-25T00:00:00Z"), used_at: now, revoked_at: null },
        { id: "3", created_at: now, expires_at: new Date("2026-09-25T00:00:00Z"), used_at: null, revoked_at: now },
        { id: "4", created_at: now, expires_at: new Date("2026-09-01T00:00:00Z"), used_at: null, revoked_at: null },
      ]);

      const result = await service.listInvitations(COACH_ID);

      expect(result.map((r) => r.status)).toEqual(["active", "used", "revoked", "expired"]);
      expect(JSON.stringify(result)).not.toMatch(/EKV-/);

      jest.useRealTimers();
    });
  });

  describe("revoke", () => {
    it("invitation inconnue -> NotFoundException", async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.revoke("inv-1")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("invitation déjà utilisée -> ConflictException, jamais silencieusement acceptée", async () => {
      repository.findById.mockResolvedValue({ used_at: new Date(), revoked_at: null });
      await expect(service.revoke("inv-1")).rejects.toBeInstanceOf(ConflictException);
      expect(repository.revoke).not.toHaveBeenCalled();
    });

    it("invitation déjà révoquée -> idempotent, pas d'erreur", async () => {
      repository.findById.mockResolvedValue({ used_at: null, revoked_at: new Date() });
      await expect(service.revoke("inv-1")).resolves.toBeUndefined();
      expect(repository.revoke).not.toHaveBeenCalled();
    });

    it("invitation active -> révoquée", async () => {
      repository.findById.mockResolvedValue({ used_at: null, revoked_at: null });
      await service.revoke("inv-1");
      expect(repository.revoke).toHaveBeenCalledWith("inv-1", expect.any(Date));
    });
  });

  describe("validate / redeem (findUsableOrThrow)", () => {
    const CODE = "EKV-ABCD2345";

    it("code inconnu -> NotFoundException", async () => {
      repository.findByCodeHash.mockResolvedValue(null);
      await expect(service.validate(CODE)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("code révoqué -> ForbiddenException", async () => {
      repository.findByCodeHash.mockResolvedValue({
        revoked_at: new Date(),
        used_at: null,
        expires_at: new Date(Date.now() + 100_000),
        club: { nom: "Team Ekvara" },
      });
      await expect(service.validate(CODE)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("code déjà utilisé -> ConflictException", async () => {
      repository.findByCodeHash.mockResolvedValue({
        revoked_at: null,
        used_at: new Date(),
        expires_at: new Date(Date.now() + 100_000),
        club: { nom: "Team Ekvara" },
      });
      await expect(service.validate(CODE)).rejects.toBeInstanceOf(ConflictException);
    });

    it("code expiré -> GoneException", async () => {
      repository.findByCodeHash.mockResolvedValue({
        revoked_at: null,
        used_at: null,
        expires_at: new Date(Date.now() - 1000),
        club: { nom: "Team Ekvara" },
      });
      await expect(service.validate(CODE)).rejects.toBeInstanceOf(GoneException);
    });

    it("code valide -> renvoie uniquement le nom du club et l'expiration", async () => {
      const expiresAt = new Date(Date.now() + 100_000);
      repository.findByCodeHash.mockResolvedValue({
        revoked_at: null,
        used_at: null,
        expires_at: expiresAt,
        club: { nom: "Team Ekvara" },
      });

      const result = await service.validate(CODE);

      expect(result).toEqual({ valid: true, club: { name: "Team Ekvara" }, expiresAt });
    });

    it("redeem() consomme via le client transactionnel fourni", async () => {
      const invitation = {
        id: "inv-1",
        revoked_at: null,
        used_at: null,
        expires_at: new Date(Date.now() + 100_000),
        club: { nom: "Team Ekvara" },
      };
      repository.findByCodeHash.mockResolvedValue(invitation);
      repository.consumeIfUsable.mockResolvedValue({ count: 1 });
      const fakeTx = {};

      const result = await service.redeem(fakeTx as never, CODE);

      expect(repository.consumeIfUsable).toHaveBeenCalledWith(fakeTx, "inv-1", expect.any(Date));
      expect(result).toBe(invitation);
    });

    it("redeem() sous concurrence (count=0) -> ConflictException, jamais une 500", async () => {
      repository.findByCodeHash.mockResolvedValue({
        id: "inv-1",
        revoked_at: null,
        used_at: null,
        expires_at: new Date(Date.now() + 100_000),
        club: { nom: "Team Ekvara" },
      });
      repository.consumeIfUsable.mockResolvedValue({ count: 0 });

      await expect(service.redeem({} as never, CODE)).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
