import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma } from "../../generated/prisma/client";

// Projection minimale : on ne renvoie jamais le modèle Prisma complet au client.
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
  competition: {
    select: {
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
    },
  },
} satisfies Prisma.participationSelect;

export type ParticipationWithCompetition = Prisma.participationGetPayload<{
  select: typeof PARTICIPATION_SELECT;
}>;

// Convention métier interne (le schéma ne définit pas d'enum pour `statut`) :
// ces valeurs désignent une participation qui ne doit plus être considérée comme
// active, notamment pour le calcul de la "prochaine compétition".
const INACTIVE_PARTICIPATION_STATUSES = ["annule", "retire"];

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
