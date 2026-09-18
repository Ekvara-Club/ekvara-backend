import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { InvitationsRepository, PrismaClientOrTx } from "./invitations.repository";
import { generateInvitationCode, hashInvitationCode, normalizeInvitationCode } from "./invitation-code.util";

const INVITATION_EXPIRY_DAYS = 7;

const GENERIC_INVALID_MESSAGE = "Ce code d'invitation n'est pas valide.";
const EXPIRED_MESSAGE = "Ce code d'invitation a expiré. Demande un nouveau code à ton coach.";
const USED_MESSAGE = "Ce code d'invitation a déjà été utilisé.";
const REVOKED_MESSAGE = "Ce code d'invitation n'est plus valide.";

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invitationsRepository: InvitationsRepository,
  ) {}

  // Le club est TOUJOURS dérivé du coach authentifié, jamais accepté du
  // client (voir ticket §"ENDPOINT COACH — CREATE"). Un coach sans club (cas
  // défensif, ne devrait pas arriver après la migration de rattachement) ne
  // peut pas générer d'invitation.
  async createInvitation(coachId: string, assignedGroupId?: string) {
    const coach = await this.prisma.coach_profile.findUnique({
      where: { id: coachId },
      select: { club_id: true },
    });
    if (!coach?.club_id) {
      throw new BadRequestException("Votre compte coach n'est rattaché à aucun club");
    }

    if (assignedGroupId) {
      await this.assertGroupOwnedByCoach(assignedGroupId, coachId);
    }

    const code = generateInvitationCode();
    const codeHash = hashInvitationCode(normalizeInvitationCode(code));
    const expiresAt = addDays(new Date(), INVITATION_EXPIRY_DAYS);

    const invitation = await this.invitationsRepository.create({
      clubId: coach.club_id,
      createdByCoachId: coachId,
      codeHash,
      expiresAt,
      assignedGroupId,
    });

    // Le code brut n'est renvoyé qu'ICI, à la création : jamais persisté en
    // clair, jamais renvoyé par listInvitations() (voir ticket §"LISTE DES
    // INVITATIONS" — si le coach perd le code, il révoque et en génère un
    // autre).
    return { invitationId: invitation.id, code, expiresAt: invitation.expires_at };
  }

  async listInvitations(coachId: string) {
    const invitations = await this.invitationsRepository.findForCoach(coachId);
    const now = new Date();
    return invitations.map((invitation) => ({
      id: invitation.id,
      createdAt: invitation.created_at,
      expiresAt: invitation.expires_at,
      usedAt: invitation.used_at,
      revokedAt: invitation.revoked_at,
      status: computeStatus(invitation, now),
    }));
  }

  async revoke(invitationId: string): Promise<void> {
    const invitation = await this.invitationsRepository.findById(invitationId);
    if (!invitation) {
      // Défensif : CoachInvitationOwnershipGuard a déjà résolu cette
      // invitation avant d'atteindre le service.
      throw new NotFoundException("Invitation introuvable");
    }
    if (invitation.used_at) {
      // Une invitation utilisée ne doit jamais redevenir "réutilisable" via
      // revoke (voir ticket §"RÉVOCATION") : refusé explicitement plutôt que
      // silencieusement no-op, pour ne pas laisser croire au coach que
      // l'action a eu un effet.
      throw new ConflictException("Cette invitation a déjà été utilisée, elle ne peut plus être révoquée");
    }
    if (invitation.revoked_at) {
      return; // Idempotent : revoke deux fois de suite n'est pas une erreur.
    }
    await this.invitationsRepository.revoke(invitationId, new Date());
  }

  // Validation publique (POST /auth/invitations/validate) : ne renvoie
  // JAMAIS coachId, clubId, hash ou toute autre métadonnée interne (voir
  // ticket §"VALIDATION PUBLIQUE DU CODE") — uniquement le nom du club et
  // l'expiration. N'a AUCUN effet de bord : le fait d'appeler /validate ne
  // consomme rien et ne donne aucun droit (revalidation stricte à
  // l'inscription, voir redeem()).
  async validate(rawCode: string) {
    const invitation = await this.findUsableOrThrow(rawCode);
    return {
      valid: true as const,
      club: { name: invitation.club.nom },
      expiresAt: invitation.expires_at,
    };
  }

  // Revalidation stricte + consommation atomique au moment du register. DOIT
  // être appelée avec le `tx` de la transaction globale de AuthService.
  // register() : si une étape ultérieure de cette transaction échoue
  // (email déjà utilisé, erreur inattendue...), le rollback Prisma annule
  // également la consommation, laissant l'invitation intacte et réutilisable
  // (voir ticket §"CODE VALIDE + REGISTER INVALIDE").
  async redeem(tx: PrismaClientOrTx, rawCode: string) {
    const invitation = await this.findUsableOrThrow(rawCode);
    const now = new Date();
    const result = await this.invitationsRepository.consumeIfUsable(tx, invitation.id, now);

    if (result.count === 0) {
      // Consommée par une requête concurrente entre la lecture ci-dessus et
      // cette tentative (voir InvitationsRepository.consumeIfUsable) : garanti
      // un usage unique même sous concurrence, jamais une 500 imprévue.
      throw new ConflictException(USED_MESSAGE);
    }

    return invitation;
  }

  private async findUsableOrThrow(rawCode: string) {
    const codeHash = hashInvitationCode(normalizeInvitationCode(rawCode));
    const invitation = await this.invitationsRepository.findByCodeHash(codeHash);

    if (!invitation) {
      throw new NotFoundException(GENERIC_INVALID_MESSAGE);
    }
    if (invitation.revoked_at) {
      throw new ForbiddenException(REVOKED_MESSAGE);
    }
    if (invitation.used_at) {
      throw new ConflictException(USED_MESSAGE);
    }
    if (invitation.expires_at.getTime() <= Date.now()) {
      throw new GoneException(EXPIRED_MESSAGE);
    }

    return invitation;
  }

  // Un groupe d'un autre coach ne doit jamais être acceptable, même
  // implicitement (voir ticket §"GROUPES" / "MULTI-COACH") : même politique
  // "jamais confirmer l'existence à qui n'en est pas propriétaire" que
  // CoachGroupOwnershipGuard, d'où un NotFoundException plutôt qu'un 403 ici
  // (ce n'est pas une requête HTTP sur ce groupe, juste un champ de payload).
  private async assertGroupOwnedByCoach(groupId: string, coachId: string): Promise<void> {
    const group = await this.prisma.coach_group.findUnique({
      where: { id: groupId },
      select: { coach_id: true },
    });
    if (!group || group.coach_id !== coachId) {
      throw new NotFoundException("Groupe introuvable");
    }
  }
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function computeStatus(
  invitation: { used_at: Date | null; revoked_at: Date | null; expires_at: Date },
  now: Date,
): "used" | "revoked" | "expired" | "active" {
  if (invitation.used_at) return "used";
  if (invitation.revoked_at) return "revoked";
  if (invitation.expires_at.getTime() <= now.getTime()) return "expired";
  return "active";
}
