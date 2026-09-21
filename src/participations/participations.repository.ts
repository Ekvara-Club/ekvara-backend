import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma } from "../../generated/prisma/client";

// Projection minimale : on ne renvoie jamais le modèle Prisma complet au client.
// Champs compétition partagés entre les vues participation et préparation
// coach (une seule définition, jamais deux projections divergentes).
const COMPETITION_SUMMARY_SELECT = {
  id: true,
  nom: true,
  date_debut: true,
  date_fin: true,
  lieu: true,
  ville: true,
  pays: true,
  niveau: true,
  // source n'est plus une colonne native de competition (voir
  // competition_source) : on prend la toute première source créée pour
  // cette competition, pour préserver le contrat CompetitionSummary
  // existant côté frontend sans exposer competition_source entier.
  sources: { orderBy: { created_at: "asc" }, take: 1, select: { source: true } },
} satisfies Prisma.competitionSelect;

export const PARTICIPATION_SELECT = {
  id: true,
  statut: true,
  categorie_poids: true,
  categorie_age: true,
  classement: true,
  medaille: true,
  victoires: true,
  defaites: true,
  points_gagnes: true,
  competition: { select: COMPETITION_SUMMARY_SELECT },
} satisfies Prisma.participationSelect;

// Projection Athlete-safe d'une coach_competition_preparation : liste BLANCHE
// explicite. note_coach, objectif, coach_id et id de préparation n'y figurent
// volontairement pas — une donnée privée coach ne peut donc pas sortir, même
// par erreur de mapping ultérieur, puisqu'elle n'est jamais lue.
export const ATHLETE_PREPARATION_SELECT = {
  competition_id: true,
  statut: true,
  categorie_age_prevue: true,
  categorie_poids_prevue: true,
  competition: { select: COMPETITION_SUMMARY_SELECT },
} satisfies Prisma.coach_competition_preparationSelect;

export type AthletePreparationRow = Prisma.coach_competition_preparationGetPayload<{
  select: typeof ATHLETE_PREPARATION_SELECT;
}>;

export type ParticipationWithCompetition = Prisma.participationGetPayload<{
  select: typeof PARTICIPATION_SELECT;
}>;

// Convention métier interne (le schéma ne définit pas d'enum pour `statut`) :
// ces valeurs désignent une participation qui ne doit plus être considérée comme
// active, notamment pour le calcul de la "prochaine compétition". Exportée
// pour être réutilisée telle quelle par CoachDashboardRepository (batch),
// jamais redupliquée en dur ailleurs.
export const INACTIVE_PARTICIPATION_STATUSES = ["annule", "retire"];

@Injectable()
export class ParticipationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async athleteExists(athleteId: string): Promise<boolean> {
    const athlete = await this.prisma.athlete.findUnique({
      where: { id: athleteId },
      select: { id: true },
    });
    return athlete !== null;
  }

  findByAthleteAndCompetition(athleteId: string, competitionId: string) {
    return this.prisma.participation.findUnique({
      where: {
        athlete_id_competition_id: { athlete_id: athleteId, competition_id: competitionId },
      },
    });
  }

  create(
    athleteId: string,
    competitionId: string,
    data: { categoriePoids?: string; categorieAge?: string },
  ) {
    return this.prisma.participation.create({
      data: {
        athlete_id: athleteId,
        competition_id: competitionId,
        categorie_poids: data.categoriePoids,
        categorie_age: data.categorieAge,
      },
      select: PARTICIPATION_SELECT,
    });
  }

  findAllByAthlete(athleteId: string): Promise<ParticipationWithCompetition[]> {
    return this.prisma.participation.findMany({
      where: { athlete_id: athleteId },
      select: PARTICIPATION_SELECT,
      orderBy: { competition: { date_debut: "asc" } },
    });
  }

  findNextByAthlete(
    athleteId: string,
    fromDate: Date,
  ): Promise<ParticipationWithCompetition | null> {
    return this.prisma.participation.findFirst({
      where: {
        athlete_id: athleteId,
        statut: { notIn: INACTIVE_PARTICIPATION_STATUSES },
        competition: { date_debut: { gte: fromDate } },
      },
      select: PARTICIPATION_SELECT,
      orderBy: { competition: { date_debut: "asc" } },
    });
  }

  // Préparations coach visibles par CET athlète uniquement (athlete_id du
  // token, jamais un paramètre libre). Filtre aussi sur le lien coach_athlete
  // encore actif : un coach retiré du roster n'expose plus rien à l'athlète
  // (même règle que côté coach, où la ligne reste en base mais disparaît).
  // `fromDate` restreint aux compétitions qui commencent à/après cette date.
  findCoachPreparationsByAthlete(athleteId: string, fromDate?: Date): Promise<AthletePreparationRow[]> {
    return this.prisma.coach_competition_preparation.findMany({
      where: {
        athlete_id: athleteId,
        coach_profile: { athletes: { some: { athlete_id: athleteId } } },
        ...(fromDate ? { competition: { date_debut: { gte: fromDate } } } : {}),
      },
      select: ATHLETE_PREPARATION_SELECT,
      orderBy: [{ competition: { date_debut: "asc" } }, { created_at: "asc" }],
    });
  }

  // Compétitions (parmi `competitionIds`) pour lesquelles l'athlète a déjà une
  // participation, QUEL QUE SOIT son statut : sert à ne jamais présenter
  // comme "prévue par le coach" une compétition déjà portée par une
  // participation (même annulée/retirée — la participation reste la source
  // métier de l'état d'inscription).
  async findParticipationCompetitionIds(athleteId: string, competitionIds: string[]): Promise<string[]> {
    if (competitionIds.length === 0) return [];
    const rows = await this.prisma.participation.findMany({
      where: { athlete_id: athleteId, competition_id: { in: competitionIds } },
      select: { competition_id: true },
    });
    return rows.map((row) => row.competition_id);
  }

  // Update partiel : une clé absente de `data` (valeur `undefined`) est omise
  // par Prisma de la requête SQL générée, jamais réécrite à null/0 — c'est ce
  // qui garantit qu'un champ non fourni dans le DTO reste inchangé en base.
  // Exception volontaire : `medaille: null` est une vraie écriture (retire une
  // médaille déjà enregistrée), distincte de `medaille` absent.
  updateResult(
    participationId: string,
    data: { classement?: number; medaille?: string | null; victoires?: number; defaites?: number },
  ): Promise<ParticipationWithCompetition> {
    return this.prisma.participation.update({
      where: { id: participationId },
      data,
      select: PARTICIPATION_SELECT,
    });
  }
}
