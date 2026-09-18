import { Injectable } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";

// Accepte indifféremment le PrismaService global ou un client de transaction
// (voir NotificationsRepository.PrismaClientOrTx pour le même besoin) :
// consumeIfUsable DOIT être appelée avec le `tx` de la transaction globale de
// AuthService.register pour que la consommation de l'invitation fasse
// partie du même rollback atomique que la création app_user/athlete.
export type PrismaClientOrTx = PrismaService | Prisma.TransactionClient;

const INVITATION_LIST_SELECT = {
  id: true,
  created_at: true,
  expires_at: true,
  used_at: true,
  revoked_at: true,
} satisfies Prisma.club_invitationSelect;

export type InvitationListRow = Prisma.club_invitationGetPayload<{ select: typeof INVITATION_LIST_SELECT }>;

@Injectable()
export class InvitationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: {
    clubId: string;
    createdByCoachId: string;
    codeHash: string;
    expiresAt: Date;
    assignedGroupId?: string;
  }) {
    return this.prisma.club_invitation.create({
      data: {
        club_id: data.clubId,
        created_by_coach_id: data.createdByCoachId,
        code_hash: data.codeHash,
        expires_at: data.expiresAt,
        assigned_group_id: data.assignedGroupId,
      },
    });
  }

  findForCoach(coachId: string): Promise<InvitationListRow[]> {
    return this.prisma.club_invitation.findMany({
      where: { created_by_coach_id: coachId },
      select: INVITATION_LIST_SELECT,
      orderBy: { created_at: "desc" },
    });
  }

  // Utilisé par CoachInvitationOwnershipGuard.
  findOwnership(id: string) {
    return this.prisma.club_invitation.findUnique({
      where: { id },
      select: { created_by_coach_id: true },
    });
  }

  findById(id: string) {
    return this.prisma.club_invitation.findUnique({ where: { id } });
  }

  // Inclut le nom du club (jamais son id complet ni d'autre métadonnée) :
  // seule donnée renvoyée par POST /auth/invitations/validate (voir
  // InvitationsService.validate).
  findByCodeHash(codeHash: string) {
    return this.prisma.club_invitation.findUnique({
      where: { code_hash: codeHash },
      include: { club: { select: { nom: true } } },
    });
  }

  revoke(id: string, now: Date) {
    return this.prisma.club_invitation.update({
      where: { id },
      data: { revoked_at: now },
    });
  }

  // Consommation atomique de l'invitation. La clause WHERE porte TOUTES les
  // conditions de validité (jamais un simple `if (!used) ...` puis update
  // séparé) : sous l'isolation READ COMMITTED de Postgres, deux requêtes
  // concurrentes ciblant la même ligne se sérialisent au niveau du verrou
  // ligne posé par la première UPDATE — la seconde ne voit le nouvel état
  // (used_at non-null) qu'après le commit de la première et ne peut donc
  // plus matcher `used_at: null`. `count` vaut alors 0 : au plus UNE requête
  // peut consommer une invitation donnée, quelle que soit la concurrence.
  consumeIfUsable(client: PrismaClientOrTx, invitationId: string, now: Date) {
    return client.club_invitation.updateMany({
      where: { id: invitationId, used_at: null, revoked_at: null, expires_at: { gt: now } },
      data: { used_at: now },
    });
  }
}
