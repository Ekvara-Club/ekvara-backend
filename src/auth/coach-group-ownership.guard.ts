import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { isUUID } from "class-validator";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";

// Réutilisable sur toutes les routes /coach/groups/:groupId/... . Doit
// s'exécuter APRÈS JwtAuthGuard. Interroge coach_group directement via
// PrismaService plutôt que CoachGroupsRepository : AuthGuardsModule est la
// racine du graphe de dépendances (voir auth-guards.module.ts) et ne doit
// dépendre d'aucun module métier, y compris CoachModule.
//
// Un groupe inconnu ou appartenant à un autre coach renvoient tous deux 403
// (jamais 404) : même politique que CoachAthleteAccessGuard, ne jamais
// confirmer l'existence d'un groupe à un coach qui n'en est pas propriétaire.
@Injectable()
export class CoachGroupOwnershipGuard implements CanActivate {
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

    const rawGroupId = request.params.groupId;

    if (typeof rawGroupId !== "string" || !isUUID(rawGroupId)) {
      throw new ForbiddenException("Accès interdit à ce groupe");
    }
    const groupId = rawGroupId;

    const group = await this.prisma.coach_group.findUnique({
      where: { id: groupId },
      select: { coach_id: true },
    });

    if (!group || group.coach_id !== user.coachId) {
      throw new ForbiddenException("Accès interdit à ce groupe");
    }

    return true;
  }
}
