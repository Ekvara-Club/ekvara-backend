import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { isUUID } from "class-validator";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";

// Réutilisable sur /coach/competitions/:competitionId/preparations/:preparationId
// (PATCH/DELETE). Doit s'exécuter APRÈS JwtAuthGuard. Même politique que
// CoachTrainingOwnershipGuard/CoachExerciseOwnershipGuard : requête directe
// via PrismaService, jamais via un repository métier (AuthGuardsModule reste
// la racine du graphe de dépendances).
//
// Une préparation appartient STRICTEMENT à coach_id — jamais à l'athlète, ni
// à la compétition seule (ticket §4/§42 : deux coachs peuvent chacun avoir
// leur propre préparation pour le même couple athlète/compétition, ce sont
// deux lignes distinctes). Préparation inconnue ou appartenant à un autre
// coach -> 403 (jamais 404), même politique que les autres guards coach :
// ne jamais confirmer l'existence d'une préparation à un coach qui n'en est
// pas propriétaire.
@Injectable()
export class CoachPreparationOwnershipGuard implements CanActivate {
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

    const rawPreparationId = request.params.preparationId;
    if (typeof rawPreparationId !== "string" || !isUUID(rawPreparationId)) {
      throw new ForbiddenException("Accès interdit à cette préparation");
    }

    const preparation = await this.prisma.coach_competition_preparation.findUnique({
      where: { id: rawPreparationId },
      select: { coach_id: true },
    });

    if (!preparation || preparation.coach_id !== user.coachId) {
      throw new ForbiddenException("Accès interdit à cette préparation");
    }

    return true;
  }
}
