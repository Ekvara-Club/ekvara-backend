import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { isUUID } from "class-validator";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";

// Réutilisable sur toutes les routes /coach/invitations/:invitationId/... .
// Doit s'exécuter APRÈS JwtAuthGuard. Interroge club_invitation directement
// via PrismaService plutôt qu'InvitationsRepository : AuthGuardsModule est la
// racine du graphe de dépendances (voir auth-guards.module.ts) et ne doit
// dépendre d'aucun module métier, y compris InvitationsModule.
//
// Une invitation inconnue ou appartenant à un autre coach renvoient toutes
// deux 403 (jamais 404) : même politique que CoachGroupOwnershipGuard /
// CoachAthleteAccessGuard — un coach A ne doit jamais pouvoir confirmer
// qu'une invitation de coach B existe (voir ticket §"MULTI-COACH").
@Injectable()
export class CoachInvitationOwnershipGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException("Authentification requise");
    }

    if (!user.coachId) {
      throw new ForbiddenException("Accès réservé aux comptes coach");
    }

    const rawInvitationId = request.params.invitationId;

    if (typeof rawInvitationId !== "string" || !isUUID(rawInvitationId)) {
      throw new ForbiddenException("Accès interdit à cette invitation");
    }

    const invitation = await this.prisma.club_invitation.findUnique({
      where: { id: rawInvitationId },
      select: { created_by_coach_id: true },
    });

    if (!invitation || invitation.created_by_coach_id !== user.coachId) {
      throw new ForbiddenException("Accès interdit à cette invitation");
    }

    return true;
  }
}
