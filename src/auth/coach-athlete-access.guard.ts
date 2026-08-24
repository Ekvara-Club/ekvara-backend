import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { isUUID } from "class-validator";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";

// Réutilisable sur toutes les routes /coach/athletes/:athleteId/... (le
// paramètre s'appelle parfois `id`, cf. AthleteOwnershipGuard). Doit
// s'exécuter APRÈS JwtAuthGuard. Contrairement à AthleteOwnershipGuard (simple
// égalité sur le payload), l'autorisation coach n'est pas contenue dans le
// token : elle dépend de coach_athlete, la SEULE source de vérité pour
// "ce coach peut-il gérer cet athlète" (jamais club_id, jamais coach_group —
// voir schema.prisma). Nécessite donc une lecture DB à chaque requête.
//
// Un athlete inconnu ou non assigné renvoient tous deux 403 (jamais 404) :
// ne jamais confirmer à un coach non autorisé qu'un UUID d'athlète existe.
@Injectable()
export class CoachAthleteAccessGuard implements CanActivate {
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

    const rawAthleteId = request.params.athleteId ?? request.params.id;

    // Les guards s'exécutent avant ParseUUIDPipe (résolu seulement au moment
    // d'invoquer le handler) : un id malformé (ou un tableau, si jamais un
    // futur pattern de route le permettait) atteindrait sinon la requête
    // Prisma typée @db.Uuid et lèverait une erreur non gérée (500) au lieu
    // d'un refus propre. Toujours 403, jamais 404/400, pour rester cohérent
    // avec la politique "ne jamais confirmer l'existence d'un UUID".
    if (typeof rawAthleteId !== "string" || !isUUID(rawAthleteId)) {
      throw new ForbiddenException("Accès interdit à cet athlète");
    }
    const athleteId = rawAthleteId;

    const link = await this.prisma.coach_athlete.findUnique({
      where: { coach_id_athlete_id: { coach_id: user.coachId, athlete_id: athleteId } },
      select: { id: true },
    });

    if (!link) {
      throw new ForbiddenException("Accès interdit à cet athlète");
    }

    return true;
  }
}
