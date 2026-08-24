import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { isUUID } from "class-validator";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";

// Réutilisable sur /coach/exercises/:exerciseId/... . Doit s'exécuter APRÈS
// JwtAuthGuard. Interroge exercise directement via PrismaService (jamais via
// un repository du module coach) : même règle architecturale que
// CoachGroupOwnershipGuard/CoachTrainingOwnershipGuard — AuthGuardsModule
// est la racine du graphe de dépendances.
//
// Un exercice système/global (created_by_coach_id = null) n'appartient à
// AUCUN coach : refusé exactement comme un exercice d'un autre coach (ticket
// §6 — "non modifiable par un coach"). Exercice inconnu ou non possédé -> 403
// (jamais 404), même politique que les autres guards coach.
@Injectable()
export class CoachExerciseOwnershipGuard implements CanActivate {
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

    const rawExerciseId = request.params.exerciseId;
    if (typeof rawExerciseId !== "string" || !isUUID(rawExerciseId)) {
      throw new ForbiddenException("Accès interdit à cet exercice");
    }

    const exercise = await this.prisma.exercise.findUnique({
      where: { id: rawExerciseId },
      select: { created_by_coach_id: true },
    });

    if (!exercise || exercise.created_by_coach_id !== user.coachId) {
      throw new ForbiddenException("Accès interdit à cet exercice");
    }

    return true;
  }
}
