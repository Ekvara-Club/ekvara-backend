import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

// Réutilisable sur tous les controllers montés sous /athletes/:athleteId/...
// (le paramètre s'appelle parfois `id`, ex. GET /athletes/:id). Doit
// s'exécuter APRÈS JwtAuthGuard dans @UseGuards() pour que request.user
// existe déjà.
@Injectable()
export class AthleteOwnershipGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException("Authentification requise");
    }

    const paramAthleteId = request.params.athleteId ?? request.params.id;

    if (paramAthleteId !== user.athleteId) {
      throw new ForbiddenException("Accès interdit aux données de cet athlète");
    }

    return true;
  }
}
