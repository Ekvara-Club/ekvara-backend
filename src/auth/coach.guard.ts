import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

// Pour les routes coach SANS athleteId dans l'URL (/coach/me, /coach/groups,
// /coach/athletes...) : vérifie uniquement que le token porte un coachId, sans
// requête DB (contrairement à CoachAthleteAccessGuard, qui doit en plus
// vérifier une relation coach_athlete). Doit s'exécuter APRÈS JwtAuthGuard.
//
// Convention 401 vs 403 (alignée sur AthleteOwnershipGuard) : 401 si aucune
// identité authentifiée n'est présente (ne devrait pas arriver après
// JwtAuthGuard, gardé en défense) ; 403 si l'utilisateur est authentifié mais
// n'a pas de profil coach (ex. un athlete-only qui appelle une route coach).
@Injectable()
export class CoachGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException("Authentification requise");
    }

    if (!user.coachId) {
      throw new ForbiddenException("Accès réservé aux comptes coach");
    }

    return true;
  }
}
