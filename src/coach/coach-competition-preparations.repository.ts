import { Injectable } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";

// Projection minimale : jamais le modèle Prisma complet exposé au client
// (même politique que PARTICIPATION_SELECT côté participations).
export const PREPARATION_SELECT = {
  id: true,
  coach_id: true,
  athlete_id: true,
  competition_id: true,
  statut: true,
  categorie_age_prevue: true,
  categorie_poids_prevue: true,
  objectif: true,
  note_coach: true,
} satisfies Prisma.coach_competition_preparationSelect;

export type CoachCompetitionPreparation = Prisma.coach_competition_preparationGetPayload<{
  select: typeof PREPARATION_SELECT;
}>;

// Extension avec la compétition jointe (mêmes champs que
// CoachCompetitionsRepository.findCompetitionRef) : nécessaire uniquement
// pour GET /coach/competitions (liste groupée par compétition), où une
// compétition peut n'apparaître QUE via une préparation (aucune
// participation officielle) — il faut alors pouvoir construire le hero de
// cette compétition à partir de la préparation elle-même.
const BATCH_PREPARATION_WITH_COMPETITION_SELECT = {
  id: true,
  athlete_id: true,
  competition_id: true,
  statut: true,
  categorie_age_prevue: true,
  categorie_poids_prevue: true,
  objectif: true,
  note_coach: true,
  competition: {
    select: { id: true, nom: true, date_debut: true, date_fin: true, ville: true, pays: true, niveau: true },
  },
} satisfies Prisma.coach_competition_preparationSelect;

export type BatchPreparationWithCompetition = Prisma.coach_competition_preparationGetPayload<{
  select: typeof BATCH_PREPARATION_WITH_COMPETITION_SELECT;
}>;

@Injectable()
export class CoachCompetitionPreparationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Vérification minimale d'existence, sans importer CompetitionsModule
  // (même principe que CoachCompetitionsRepository qui interroge déjà
  // `competition` directement plutôt que via CompetitionsRepository — pas
  // de couplage inter-module pour un simple existsById).
  competitionExists(competitionId: string): Promise<boolean> {
    return this.prisma.competition
      .findUnique({ where: { id: competitionId }, select: { id: true } })
      .then((row) => row !== null);
  }

  findByCoachAndId(coachId: string, preparationId: string): Promise<CoachCompetitionPreparation | null> {
    return this.prisma.coach_competition_preparation.findFirst({
      where: { id: preparationId, coach_id: coachId },
      select: PREPARATION_SELECT,
    });
  }

  findByCoachAthleteCompetition(
    coachId: string,
    athleteId: string,
    competitionId: string,
  ): Promise<CoachCompetitionPreparation | null> {
    return this.prisma.coach_competition_preparation.findUnique({
      where: { coach_id_athlete_id_competition_id: { coach_id: coachId, athlete_id: athleteId, competition_id: competitionId } },
      select: PREPARATION_SELECT,
    });
  }

  // Batch, jamais une requête par athlète (même discipline que
  // CoachCompetitionsRepository) : sert GET /coach/competitions (roster
  // entier, toutes compétitions confondues — voir CoachCompetitionsService
  // pour la fusion avec les participations officielles).
  findForAthletesWithCompetition(athleteIds: string[], coachId: string): Promise<BatchPreparationWithCompetition[]> {
    if (athleteIds.length === 0) return Promise.resolve([]);
    return this.prisma.coach_competition_preparation.findMany({
      where: { coach_id: coachId, athlete_id: { in: athleteIds } },
      select: BATCH_PREPARATION_WITH_COMPETITION_SELECT,
    });
  }

  // Sert GET /coach/competitions/:competitionId : compétition déjà connue
  // (route param), jamais besoin de la rejoindre ici.
  findForCompetition(coachId: string, competitionId: string): Promise<CoachCompetitionPreparation[]> {
    return this.prisma.coach_competition_preparation.findMany({
      where: { coach_id: coachId, competition_id: competitionId },
      select: PREPARATION_SELECT,
    });
  }

  create(
    coachId: string,
    athleteId: string,
    competitionId: string,
    data: { statut: string; categorie_age_prevue?: string; categorie_poids_prevue?: string; objectif?: string; note_coach?: string },
  ): Promise<CoachCompetitionPreparation> {
    return this.prisma.coach_competition_preparation.create({
      data: { coach_id: coachId, athlete_id: athleteId, competition_id: competitionId, ...data },
      select: PREPARATION_SELECT,
    });
  }

  update(
    preparationId: string,
    data: { statut?: string; categorie_age_prevue?: string; categorie_poids_prevue?: string; objectif?: string; note_coach?: string },
  ): Promise<CoachCompetitionPreparation> {
    return this.prisma.coach_competition_preparation.update({
      where: { id: preparationId },
      data: { ...data, updated_at: new Date() },
      select: PREPARATION_SELECT,
    });
  }

  delete(preparationId: string): Promise<void> {
    return this.prisma.coach_competition_preparation.delete({ where: { id: preparationId } }).then(() => undefined);
  }
}
