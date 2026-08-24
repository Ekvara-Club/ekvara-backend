import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { isUUID } from "class-validator";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";

// Réutilisable sur /coach/trainings/:trainingId/... . Doit s'exécuter APRÈS
// JwtAuthGuard. Interroge coach_training_session directement via
// PrismaService (jamais via un repository du module coach) : même règle
// architecturale que CoachGroupOwnershipGuard — AuthGuardsModule est la
// racine du graphe de dépendances, aucune dépendance vers un module métier.
//
// Séance inconnue ou appartenant à un autre coach -> 403 (jamais 404), même
// politique que les autres guards coach : ne jamais confirmer l'existence
// d'une séance à un coach qui n'en est pas propriétaire.
@Injectable()
export class CoachTrainingOwnershipGuard implements CanActivate {
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

    const rawTrainingId = request.params.trainingId;
    if (typeof rawTrainingId !== "string" || !isUUID(rawTrainingId)) {
      throw new ForbiddenException("Accès interdit à cette séance");
    }

    const session = await this.prisma.coach_training_session.findUnique({
      where: { id: rawTrainingId },
      select: { coach_id: true },
    });

    if (!session || session.coach_id !== user.coachId) {
      throw new ForbiddenException("Accès interdit à cette séance");
    }

    return true;
  }
}
