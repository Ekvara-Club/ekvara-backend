import { Injectable } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { MetricsRepository } from "../metrics/metrics.repository";
import { PARTICIPATION_SELECT, INACTIVE_PARTICIPATION_STATUSES } from "../participations/participations.repository";
import { INACTIVE_TRAINING_STATUSES } from "../trainings/trainings.repository";
import { GOAL_SELECT } from "../goals/goals.repository";

// Étend la projection existante (jamais redéfinie) avec athlete_id, requis ici
// pour regrouper un résultat multi-athlètes en mémoire — PARTICIPATION_SELECT
// seul suffit à un repository scoped à un athlète (le contexte est déjà
// connu de l'appelant), pas à une requête batch.
const BATCH_PARTICIPATION_SELECT = {
  ...PARTICIPATION_SELECT,
  athlete_id: true,
} satisfies Prisma.participationSelect;

const BATCH_GOAL_SELECT = {
  ...GOAL_SELECT,
  athlete_id: true,
} satisfies Prisma.athlete_goalSelect;

// Projection Athlete/Coach minimale d'une préparation pour "prochaine
// compétition" : liste blanche explicite. note_coach et objectif n'y figurent
// volontairement pas (jamais lus ici, donc jamais exposables par ce chemin).
const BATCH_UPCOMING_PREPARATION_SELECT = {
  athlete_id: true,
  competition_id: true,
  statut: true,
  categorie_age_prevue: true,
  categorie_poids_prevue: true,
  competition: {
    select: { id: true, nom: true, date_debut: true, ville: true, pays: true, niveau: true },
  },
} satisfies Prisma.coach_competition_preparationSelect;

export type BatchUpcomingPreparation = Prisma.coach_competition_preparationGetPayload<{
  select: typeof BATCH_UPCOMING_PREPARATION_SELECT;
}>;

export type BatchParticipation = Prisma.participationGetPayload<{ select: typeof BATCH_PARTICIPATION_SELECT }>;
export type BatchGoal = Prisma.athlete_goalGetPayload<{ select: typeof BATCH_GOAL_SELECT }>;

// Toutes les méthodes ici sont volontairement des `findMany` scoped par
// `athlete_id: { in: athleteIds }` plutôt que des requêtes par athlète : voir
// CoachDashboardService pour le regroupement en mémoire. Le nombre de
// requêtes de ce repository est constant, indépendant du nombre d'athlètes
// (voir rapport §20).
@Injectable()
export class CoachDashboardRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metricsRepository: MetricsRepository,
  ) {}

  // Pour CoachDashboardService.resolveScope (filtre ?groupId) : coach_id pour
  // vérifier la propriété, membres pour restreindre le roster. Un seul aller
  // Postgres pour les deux besoins.
  findGroupWithMemberIds(groupId: string) {
    return this.prisma.coach_group.findUnique({
      where: { id: groupId },
      select: { coach_id: true, members: { select: { athlete_id: true } } },
    });
  }

  // Groupes (id, name) de chaque athlète, restreints aux groupes DE CE COACH
  // (un athlète hybride/partagé peut appartenir à des groupes d'un autre
  // coach — jamais exposés ici).
  findGroupsForAthletes(athleteIds: string[], coachId: string) {
    return this.prisma.coach_group_athlete.findMany({
      where: { athlete_id: { in: athleteIds }, coach_group: { coach_id: coachId } },
      select: { athlete_id: true, coach_group: { select: { id: true, name: true } } },
    });
  }

  // Historique complet des pesées des athlètes demandés, trié par athlète
  // puis date décroissante : permet de retrouver en mémoire à la fois la
  // dernière pesée ET la mesure de référence à ~7 jours (voir
  // CoachDashboardService.buildWeightView), sans requête ciblée par athlète.
  findWeightLogsForAthletes(athleteIds: string[]) {
    return this.prisma.weight_log.findMany({
      where: { athlete_id: { in: athleteIds } },
      select: { athlete_id: true, valeur_kg: true, date_mesure: true },
      orderBy: [{ athlete_id: "asc" }, { date_mesure: "desc" }],
    });
  }

  // Tous les objectifs de poids actifs des athlètes demandés. Un athlète ne
  // devrait avoir qu'un seul actif à la fois (WeightsRepository.
  // replaceActiveWeightTarget le garantit), mais on trie par created_at desc
  // pour ne garder que le plus récent en mémoire si jamais ce n'était pas le
  // cas.
  findActiveWeightTargetsForAthletes(athleteIds: string[]) {
    return this.prisma.weight_target.findMany({
      where: { athlete_id: { in: athleteIds }, actif: true },
      orderBy: [{ athlete_id: "asc" }, { created_at: "desc" }],
    });
  }

  findAllMetricTypes() {
    return this.metricsRepository.findAllMetricTypes();
  }

  // Toutes les mesures des athlètes demandés, triées pour permettre de
  // retrouver les deux dernières mesures par (athlete, metric_type) en
  // mémoire — équivalent batch de MetricsRepository.findLastTwoMeasurements.
  findMeasurementsForAthletes(athleteIds: string[]) {
    return this.prisma.metric_measurement.findMany({
      where: { athlete_id: { in: athleteIds } },
      orderBy: [{ athlete_id: "asc" }, { metric_type_id: "asc" }, { mesure_le: "desc" }],
    });
  }

  // Sert à la fois "prochaine compétition" par athlète (premier élément par
  // athlete_id après tri) ET la vue groupée upcomingCompetitions (voir
  // ticket §17) : une seule requête pour les deux besoins plutôt que deux
  // requêtes redondantes sur la même donnée.
  findUpcomingParticipationsForAthletes(athleteIds: string[], fromDate: Date): Promise<BatchParticipation[]> {
    return this.prisma.participation.findMany({
      where: {
        athlete_id: { in: athleteIds },
        statut: { notIn: INACTIVE_PARTICIPATION_STATUSES },
        competition: { date_debut: { gte: fromDate } },
      },
      select: BATCH_PARTICIPATION_SELECT,
      orderBy: [{ athlete_id: "asc" }, { competition: { date_debut: "asc" } }],
    });
  }

  // Compétitions à venir où l'athlète a une participation, QUEL QUE SOIT son
  // statut (annulée/retirée comprises) : sert uniquement à ne jamais présenter
  // comme "préparée par le coach" une compétition déjà portée par une
  // participation (voir selectNextCompetition). Même filtre de date que
  // findUpcomingParticipationsForAthletes, une seule définition d'"à venir".
  findUpcomingParticipationLinksForAthletes(
    athleteIds: string[],
    fromDate: Date,
  ): Promise<{ athlete_id: string; competition_id: string }[]> {
    return this.prisma.participation.findMany({
      where: { athlete_id: { in: athleteIds }, competition: { date_debut: { gte: fromDate } } },
      select: { athlete_id: true, competition_id: true },
    });
  }

  // Préparations à venir de CE coach uniquement (coach_id fait partie du
  // filtre, jamais seulement athlete_id) : une préparation d'un autre coach du
  // même athlète n'est ni lue ni exposable ici. Batch, jamais une requête par
  // athlète.
  findUpcomingPreparationsForAthletes(
    athleteIds: string[],
    coachId: string,
    fromDate: Date,
  ): Promise<BatchUpcomingPreparation[]> {
    return this.prisma.coach_competition_preparation.findMany({
      where: {
        coach_id: coachId,
        athlete_id: { in: athleteIds },
        competition: { date_debut: { gte: fromDate } },
      },
      select: BATCH_UPCOMING_PREPARATION_SELECT,
      orderBy: [{ athlete_id: "asc" }, { competition: { date_debut: "asc" } }, { created_at: "asc" }],
    });
  }

  // Équivalent batch de TrainingsRepository.findNextByAthlete (même règle
  // "actif et pas terminé", même statuts inactifs).
  findUpcomingTrainingsForAthletes(athleteIds: string[], now: Date) {
    return this.prisma.training_session.findMany({
      where: {
        athlete_id: { in: athleteIds },
        statut: { notIn: INACTIVE_TRAINING_STATUSES },
        OR: [{ date_fin: { gte: now } }, { date_fin: null, date_debut: { gte: now } }],
      },
      orderBy: [{ athlete_id: "asc" }, { date_debut: "asc" }],
    });
  }

  // Équivalent batch de GoalsRepository.findActiveByAthlete (même statut
  // "en_cours", même tri date_cible croissante puis created_at).
  findActiveGoalsForAthletes(athleteIds: string[]): Promise<BatchGoal[]> {
    return this.prisma.athlete_goal.findMany({
      where: { athlete_id: { in: athleteIds }, statut: "en_cours" },
      select: BATCH_GOAL_SELECT,
      orderBy: [{ athlete_id: "asc" }, { date_cible: { sort: "asc", nulls: "last" } }, { created_at: "asc" }],
    });
  }
}
