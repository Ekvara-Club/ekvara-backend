import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { isUUID } from "class-validator";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";

// Réutilisable sur /coach/competitions/:competitionId. Doit s'exécuter APRÈS
// JwtAuthGuard. Même politique architecturale que CoachTrainingOwnershipGuard
// (requête directe via PrismaService, jamais via un repository métier) —
// AuthGuardsModule reste la racine du graphe de dépendances.
//
// Contrairement aux autres guards "ownership" (coach_id direct sur la
// ressource), une compétition n'appartient à aucun coach : la "propriété"
// ici signifie "au moins un athlète du roster de ce coach a une
// participation à cette compétition" (ticket Compétitions Coach V1 §8)
// OU "ce coach a déjà commencé une préparation interne sur cette
// compétition" (ticket Sélection & préparation V1 §21 — un coach doit
// pouvoir consulter/continuer à préparer une compétition AVANT toute
// inscription officielle connue de son roster ; la création de la TOUTE
// PREMIÈRE préparation, elle, ne passe jamais par ce guard — voir
// CoachCompetitionPreparationsController.create, protégé par CoachGuard
// seul, précisément pour ne pas créer de dépendance circulaire ici).
// Le statut de la participation (inscrit/annulé/retiré) n'est volontairement
// PAS filtré ici : une relation passée (même annulée) reste une raison
// légitime pour le coach de consulter la fiche — le filtrage par statut actif
// s'applique seulement à la liste des athlètes affichés par le service, pas
// à l'accès lui-même. Compétition sans lien avec le roster ET sans
// préparation -> 403 (jamais 404), même politique que les autres guards coach.
@Injectable()
export class CoachCompetitionOwnershipGuard implements CanActivate {
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

    const rawCompetitionId = request.params.competitionId;
    if (typeof rawCompetitionId !== "string" || !isUUID(rawCompetitionId)) {
      throw new ForbiddenException("Accès interdit à cette compétition");
    }

    const [participationLink, preparationLink] = await Promise.all([
      this.prisma.coach_athlete.findFirst({
        where: {
          coach_id: user.coachId,
          athlete: { participation: { some: { competition_id: rawCompetitionId } } },
        },
        select: { athlete_id: true },
      }),
      this.prisma.coach_competition_preparation.findFirst({
        where: { coach_id: user.coachId, competition_id: rawCompetitionId },
        select: { id: true },
      }),
    ]);

    if (!participationLink && !preparationLink) {
      throw new ForbiddenException("Accès interdit à cette compétition");
    }

    return true;
  }
}
