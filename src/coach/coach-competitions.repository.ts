import { Injectable } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PARTICIPATION_SELECT, INACTIVE_PARTICIPATION_STATUSES } from "../participations/participations.repository";
import { CoachDashboardRepository } from "./coach-dashboard.repository";

// Même extension que CoachDashboardRepository.BATCH_PARTICIPATION_SELECT
// (jamais redéfinie séparément) : athlete_id requis pour regrouper un
// résultat multi-athlètes en mémoire.
const BATCH_PARTICIPATION_SELECT = {
  ...PARTICIPATION_SELECT,
  athlete_id: true,
} satisfies Prisma.participationSelect;

export type BatchParticipation = Prisma.participationGetPayload<{ select: typeof BATCH_PARTICIPATION_SELECT }>;

// Toutes les méthodes ici sont des `findMany` scoped par
// `athlete_id: { in: athleteIds }` (jamais une requête par athlète) : même
// discipline que CoachDashboardRepository, nombre de requêtes constant quel
// que soit le nombre d'athlètes du roster (voir rapport §6).
@Injectable()
export class CoachCompetitionsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dashboardRepository: CoachDashboardRepository,
  ) {}

  // Sert /coach/competitions : toutes les participations actives (jamais
  // annule/retire, ticket §17) des athlètes du roster, futures ET passées —
  // le service se charge de les répartir en deux groupes selon la date, une
  // seule requête couvre les deux besoins plutôt que deux requêtes
  // redondantes sur la même table.
  findParticipationsForAthletes(athleteIds: string[]): Promise<BatchParticipation[]> {
    if (athleteIds.length === 0) return Promise.resolve([]);
    return this.prisma.participation.findMany({
      where: {
        athlete_id: { in: athleteIds },
        statut: { notIn: INACTIVE_PARTICIPATION_STATUSES },
      },
      select: BATCH_PARTICIPATION_SELECT,
      orderBy: [{ competition: { date_debut: "asc" } }, { athlete_id: "asc" }],
    });
  }

  // Sert /coach/competitions/:competitionId : mêmes filtres de statut que
  // findParticipationsForAthletes (jamais annule/retire, ticket §17) — une
  // participation annulée ne doit pas plus apparaître ici que dans la liste,
  // pour une cohérence stricte entre les deux vues. L'ACCÈS à la page ne
  // dépend pas de ce filtre (CoachCompetitionOwnershipGuard vérifie l'EXISTENCE
  // d'un lien, quel que soit son statut) : un coach dont le seul athlète lié
  // a retiré sa participation peut toujours ouvrir la page, elle affichera
  // simplement une liste d'athlètes vide plutôt qu'un 403 trompeur.
  findParticipationsForAthletesAndCompetition(athleteIds: string[], competitionId: string): Promise<BatchParticipation[]> {
    if (athleteIds.length === 0) return Promise.resolve([]);
    return this.prisma.participation.findMany({
      where: {
        athlete_id: { in: athleteIds },
        competition_id: competitionId,
        statut: { notIn: INACTIVE_PARTICIPATION_STATUSES },
      },
      select: BATCH_PARTICIPATION_SELECT,
    });
  }

  // Sert le hero de /coach/competitions/:competitionId indépendamment des
  // participations actives trouvées : si le seul athlète lié a retiré sa
  // participation, la page doit quand même pouvoir afficher QUELLE
  // compétition c'est (juste une liste d'athlètes vide), jamais un hero
  // vide faute de participation active à partir de laquelle le dériver.
  findCompetitionRef(competitionId: string) {
    return this.prisma.competition.findUnique({
      where: { id: competitionId },
      select: { id: true, nom: true, date_debut: true, date_fin: true, ville: true, pays: true, niveau: true },
    });
  }

  // Groupes (id, name) de chaque athlète, restreints aux groupes DE CE COACH
  // — réutilise CoachDashboardRepository.findGroupsForAthletes tel quel
  // (même besoin exact), jamais une requête dupliquée.
  findGroupsForAthletes(athleteIds: string[], coachId: string) {
    if (athleteIds.length === 0) return Promise.resolve([]);
    return this.dashboardRepository.findGroupsForAthletes(athleteIds, coachId);
  }
}
