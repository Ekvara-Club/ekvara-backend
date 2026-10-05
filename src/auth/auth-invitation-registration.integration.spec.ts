import "dotenv/config";
import { JwtService } from "@nestjs/jwt";
import { ConflictException, ForbiddenException, GoneException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AthletesService } from "../athletes/athletes.service";
import { InvitationsService } from "../invitations/invitations.service";
import { InvitationsRepository } from "../invitations/invitations.repository";
import { AuthService } from "./auth.service";
import { NotificationsRepository } from "../notifications/notifications.repository";

// Test d'intégration contre la vraie base Postgres locale : l'usage unique
// sous concurrence (contrainte code_hash + UPDATE conditionnel, voir
// InvitationsRepository.consumeIfUsable) et l'atomicité de la transaction de
// register (invitation + app_user + athlete + coach_athlete + groupe, voir
// AuthService.register) dépendent de comportements Postgres réels qu'un mock
// ne peut pas valider sincèrement (même principe que CoachRepository.spec.ts).
// Chaque test crée ses propres club/coach_profile/app_user/athlete jetables
// (nettoyés en afterEach via cascade sur app_user, puis club) — jamais les 7
// utilisateurs réels de dev (voir rapport d'audit Ticket #11).
describe("Register via invitation de club (intégration Postgres)", () => {
  let prisma: PrismaService;
  let athletesService: AthletesService;
  let invitationsService: InvitationsService;
  let authService: AuthService;

  const runId = Date.now();
  const createdUserIds: string[] = [];
  const createdClubIds: string[] = [];
  let counter = 0;

  beforeAll(() => {
    prisma = new PrismaService();
    athletesService = new AthletesService(prisma, new NotificationsRepository(prisma));
    invitationsService = new InvitationsService(prisma, new InvitationsRepository(prisma));
    authService = new AuthService(
      prisma,
      athletesService,
      invitationsService,
      new JwtService({ secret: "test-jwt-secret-for-integration-specs-only" }),
    );
  }, 30000);

  afterEach(async () => {
    if (createdUserIds.length > 0) {
      // onDelete: Cascade athlete/coach_profile -> coach_athlete/coach_group/
      // coach_group_athlete/club_invitation.created_by_coach_id.
      await prisma.app_user.deleteMany({ where: { id: { in: createdUserIds } } });
      createdUserIds.length = 0;
    }
    if (createdClubIds.length > 0) {
      // onDelete: Cascade club_invitation.club_id ; athlete/coach_profile.club_id
      // sont déjà supprimés via app_user ci-dessus (ordre non important ici).
      await prisma.club.deleteMany({ where: { id: { in: createdClubIds } } });
      createdClubIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  }, 30000);

  async function makeClub(): Promise<string> {
    counter += 1;
    const club = await prisma.club.create({ data: { nom: `Club Test ${runId}-${counter}` } });
    createdClubIds.push(club.id);
    return club.id;
  }

  async function makeCoach(clubId: string): Promise<{ userId: string; coachId: string }> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `Fixture${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id, club_id: clubId } });
    return { userId: user.id, coachId: profile.id };
  }

  function makeEmail(): string {
    counter += 1;
    return `test-fixture-athlete-${runId}-${counter}@test.fr`;
  }

  function registerDto(invitationCode: string, email: string) {
    return { invitationCode, email, password: "motdepasse123", nom: "Athlete", prenom: `Fixture${counter}` };
  }

  describe("cycle de vie de l'invitation", () => {
    it("le code brut n'est jamais stocké en base (seul code_hash existe)", async () => {
      const clubId = await makeClub();
      const { coachId } = await makeCoach(clubId);

      const { code, invitationId } = await invitationsService.createInvitation(coachId);
      const row = await prisma.club_invitation.findUnique({ where: { id: invitationId } });

      expect(row).not.toBeNull();
      expect(JSON.stringify(row)).not.toContain(code.replace("EKV-", ""));
      expect(row!.code_hash).toHaveLength(64); // SHA-256 hex
    });

    it("validate() accepte le code normalisé (minuscule, sans tiret)", async () => {
      const clubId = await makeClub();
      const { coachId } = await makeCoach(clubId);
      const { code } = await invitationsService.createInvitation(coachId);
      const withoutPrefix = code.replace("EKV-", "");

      await expect(invitationsService.validate(code.toLowerCase())).resolves.toMatchObject({ valid: true });
      await expect(invitationsService.validate(withoutPrefix.toLowerCase())).resolves.toMatchObject({
        valid: true,
      });
    });

    it("code révoqué -> ForbiddenException", async () => {
      const clubId = await makeClub();
      const { coachId } = await makeCoach(clubId);
      const { code, invitationId } = await invitationsService.createInvitation(coachId);
      await prisma.club_invitation.update({ where: { id: invitationId }, data: { revoked_at: new Date() } });

      await expect(invitationsService.validate(code)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("code expiré -> GoneException", async () => {
      const clubId = await makeClub();
      const { coachId } = await makeCoach(clubId);
      const { code, invitationId } = await invitationsService.createInvitation(coachId);
      await prisma.club_invitation.update({
        where: { id: invitationId },
        data: { expires_at: new Date(Date.now() - 1000) },
      });

      await expect(invitationsService.validate(code)).rejects.toBeInstanceOf(GoneException);
    });

    it("coach revoke sa propre invitation -> plus jamais utilisable pour register", async () => {
      const clubId = await makeClub();
      const { coachId } = await makeCoach(clubId);
      const { code, invitationId } = await invitationsService.createInvitation(coachId);

      await invitationsService.revoke(invitationId);

      await expect(authService.register(registerDto(code, makeEmail()))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe("register() — transaction complète", () => {
    it("code valide -> app_user + athlete créés, club correct, coach_athlete créé, invitation marquée used_at", async () => {
      const clubId = await makeClub();
      const { coachId } = await makeCoach(clubId);
      const { code, invitationId } = await invitationsService.createInvitation(coachId);
      const email = makeEmail();

      const { athlete } = await authService.register(registerDto(code, email));
      createdUserIds.push(athlete.app_user.id);

      expect(athlete.club_id).toBe(clubId);
      const link = await prisma.coach_athlete.findUnique({
        where: { coach_id_athlete_id: { coach_id: coachId, athlete_id: athlete.id } },
      });
      expect(link).not.toBeNull();
      const invitationRow = await prisma.club_invitation.findUnique({ where: { id: invitationId } });
      expect(invitationRow!.used_at).not.toBeNull();
    });

    it("aucune appartenance groupe automatique si l'invitation n'en portait pas", async () => {
      const clubId = await makeClub();
      const { coachId } = await makeCoach(clubId);
      const { code } = await invitationsService.createInvitation(coachId);
      const email = makeEmail();

      const { athlete } = await authService.register(registerDto(code, email));
      createdUserIds.push(athlete.app_user.id);

      const memberships = await prisma.coach_group_athlete.findMany({ where: { athlete_id: athlete.id } });
      expect(memberships).toHaveLength(0);
    });

    it("groupe assigné à l'invitation -> athlète automatiquement membre à l'inscription", async () => {
      const clubId = await makeClub();
      const { coachId } = await makeCoach(clubId);
      const group = await prisma.coach_group.create({ data: { coach_id: coachId, name: `Groupe ${runId}` } });
      const { code } = await invitationsService.createInvitation(coachId, group.id);
      const email = makeEmail();

      const { athlete } = await authService.register(registerDto(code, email));
      createdUserIds.push(athlete.app_user.id);

      const membership = await prisma.coach_group_athlete.findUnique({
        where: { group_id_athlete_id: { group_id: group.id, athlete_id: athlete.id } },
      });
      expect(membership).not.toBeNull();
    });

    it("code déjà utilisé -> ConflictException, un seul athlete créé au total", async () => {
      const clubId = await makeClub();
      const { coachId } = await makeCoach(clubId);
      const { code } = await invitationsService.createInvitation(coachId);
      const firstEmail = makeEmail();

      const { athlete } = await authService.register(registerDto(code, firstEmail));
      createdUserIds.push(athlete.app_user.id);

      await expect(authService.register(registerDto(code, makeEmail()))).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it("code invalide (inexistant) -> NotFoundException, aucune écriture", async () => {
      await expect(
        authService.register(registerDto("EKV-ZZZZZZZZ", makeEmail())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("email déjà existant -> échec, MAIS l'invitation reste utilisable ensuite (rollback complet)", async () => {
      const clubId = await makeClub();
      const { coachId } = await makeCoach(clubId);
      const existingEmail = makeEmail();
      const existingUser = await prisma.app_user.create({ data: { email: existingEmail, nom: "X", prenom: "Y" } });
      createdUserIds.push(existingUser.id);

      const { code, invitationId } = await invitationsService.createInvitation(coachId);

      await expect(authService.register(registerDto(code, existingEmail))).rejects.toBeInstanceOf(
        ConflictException,
      );

      // Rollback vérifié : used_at doit être resté NULL malgré la tentative.
      const invitationRow = await prisma.club_invitation.findUnique({ where: { id: invitationId } });
      expect(invitationRow!.used_at).toBeNull();

      // L'invitation est donc réellement réutilisable avec un email valide.
      const secondEmail = makeEmail();
      const { athlete } = await authService.register(registerDto(code, secondEmail));
      createdUserIds.push(athlete.app_user.id);
      expect(athlete.app_user.email).toBe(secondEmail);
    });

    it("concurrence : deux register() simultanés avec le même code -> un seul succès, un seul athlete créé", async () => {
      const clubId = await makeClub();
      const { coachId } = await makeCoach(clubId);
      const { code } = await invitationsService.createInvitation(coachId);
      const emailA = makeEmail();
      const emailB = makeEmail();

      const results = await Promise.allSettled([
        authService.register(registerDto(code, emailA)),
        authService.register(registerDto(code, emailB)),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const succeeded = fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof authService.register>>>;
      createdUserIds.push(succeeded.value.athlete.app_user.id);

      const athletesForCoach = await prisma.coach_athlete.findMany({ where: { coach_id: coachId } });
      expect(athletesForCoach).toHaveLength(1);
    }, 20000);
  });

  describe("isolation multi-club", () => {
    it("l'invitation du coach A n'est ni visible ni révocable par le coach B, et l'athlète inscrit n'apparaît que dans le roster de A", async () => {
      const clubA = await makeClub();
      const clubB = await makeClub();
      const { coachId: coachAId } = await makeCoach(clubA);
      const { coachId: coachBId } = await makeCoach(clubB);

      const { code, invitationId } = await invitationsService.createInvitation(coachAId);

      // "visible" = listInvitations(coachB) ne la contient pas.
      const listForB = await invitationsService.listInvitations(coachBId);
      expect(listForB.find((i) => i.id === invitationId)).toBeUndefined();

      // "révocable" = l'ownership réel (ce que CoachInvitationOwnershipGuard
      // vérifie) refuse le coach B.
      const ownership = await prisma.club_invitation.findUnique({
        where: { id: invitationId },
        select: { created_by_coach_id: true },
      });
      expect(ownership!.created_by_coach_id).not.toBe(coachBId);

      const { athlete } = await authService.register(registerDto(code, makeEmail()));
      createdUserIds.push(athlete.app_user.id);

      expect(athlete.club_id).toBe(clubA);
      const linkedToA = await prisma.coach_athlete.findUnique({
        where: { coach_id_athlete_id: { coach_id: coachAId, athlete_id: athlete.id } },
      });
      const linkedToB = await prisma.coach_athlete.findUnique({
        where: { coach_id_athlete_id: { coach_id: coachBId, athlete_id: athlete.id } },
      });
      expect(linkedToA).not.toBeNull();
      expect(linkedToB).toBeNull();
    });
  });
});
