import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { compareMeasurements } from "../metrics/metrics.service";
import { computeWeightSummary, REFERENCE_WINDOW_MS, WeightSummaryView } from "../weights/weights.service";
import { computeGoalProgress } from "../goals/goals.service";
import { selectNextCompetition, todayUtcMidnight } from "../competitions/next-competition";
import { daysUntil } from "./dashboard-date.util";
import { CoachRepository } from "./coach.repository";
import { CoachGroupsRepository } from "./coach-groups.repository";
import {
  BatchGoal,
  BatchParticipation,
  BatchUpcomingPreparation,
  CoachDashboardRepository,
} from "./coach-dashboard.repository";

// ---------------------------------------------------------------------------
// Types de sortie (voir rapport final §4 pour la justification de la forme)
// ---------------------------------------------------------------------------

export interface AthleteGroupRef {
  id: string;
  name: string;
}

// Préparation de CE coach pour la compétition (jamais celle d'un autre coach,
// jamais la note privée). Sur une participation, sert d'enrichissement.
export interface NextCompetitionPreparationView {
  status: string;
  targetAgeCategory: string | null;
  targetWeightCategory: string | null;
}

// `weightCategory`/`ageCategory` = catégories OFFICIELLES de la participation
// (null pour une compétition seulement préparée) ; les catégories PRÉVUES du
// coach vivent dans `preparation` : jamais mélangées, l'officiel n'est jamais
// falsifié par le prévu.
export interface NextCompetitionView {
  id: string;
  name: string;
  startDate: Date;
  city: string | null;
  country: string | null;
  level: string | null;
  weightCategory: string | null;
  ageCategory: string | null;
  source: "participation" | "coach_preparation";
  preparation: NextCompetitionPreparationView | null;
  daysUntil: number;
}

export interface NextTrainingView {
  id: string;
  title: string;
  startAt: Date;
  endAt: Date | null;
  type: string | null;
}

export interface PrimaryGoalView {
  id: string;
  title: string;
  targetDate: Date | null;
  daysUntil: number | null;
  progressPercentage: number | null;
  completedSteps: number;
  totalSteps: number;
}

export interface ProgressionView {
  improvedCount: number;
  decliningCount: number;
  unknownCount: number;
  evaluatedCount: number;
  // Aucun concept métier canonique de "statut global" n'existe aujourd'hui
  // (voir MetricsService : seuls des statuts PAR métrique existent). Ticket
  // §10 : toujours null plutôt qu'un score inventé — exposer les counts
  // ci-dessus et laisser le frontend/l'utilisateur interpréter.
  overallStatus: null;
}

// État de forme déclaré par l'athlète lui-même (PUT /athletes/:id/condition),
// jamais déduit ici. expectedReturn : date métier YYYY-MM-DD.
export interface AthleteConditionView {
  status: string;
  note: string | null;
  expectedReturn: string | null;
  updatedAt: Date | null;
}

// Profil World Taekwondo relié (ou demandé) par l'athlète — voir
// athlete_wt_link. status "pending" = en attente de la décision du coach.
export interface AthleteWtProfileView {
  status: string;
  externalAthleteId: string;
  displayName: string;
  countryCode: string | null;
}

export interface AthleteDashboardSummary {
  id: string;
  firstName: string | null;
  lastName: string | null;
  ageCategory: string | null;
  grade: string | null;
  sportLevel: string | null;
  condition: AthleteConditionView;
  wtProfile: AthleteWtProfileView | null;
  groups: AthleteGroupRef[];
  weight: WeightSummaryView;
  progression: ProgressionView;
  nextCompetition: NextCompetitionView | null;
  nextTraining: NextTrainingView | null;
  primaryGoal: PrimaryGoalView | null;
}

export type AttentionReasonType =
  | "WEIGHT_ABOVE_TARGET"
  | "WEIGHT_BELOW_TARGET"
  | "NO_WEIGHT_TARGET"
  | "METRIC_DECLINING"
  | "NO_METRIC_DATA"
  // État de forme déclaré par l'athlète (tout sauf "actif") : un fait
  // déclaré, jamais un jugement — produit pour le dashboard global ET groupe.
  | "CONDITION_INJURED"
  | "CONDITION_SICK"
  | "CONDITION_ABSENT"
  // Demande de lien vers un profil World Taekwondo à confirmer/refuser.
  | "WT_LINK_PENDING"
  // Ticket "Dashboard groupe Coach V1" §21-25 : jamais produites par
  // buildAttentionList (dashboard global, inchangé) — uniquement par
  // CoachGroupDashboardService, qui les ajoute par-dessus
  // computeBaseAttentionReasons. Seuils validés explicitement avec
  // l'utilisateur avant implémentation (voir rapport final) :
  // ATTENDANCE_LOW seulement si recordedSessions >= 3 ET taux < 70% ;
  // aucun seuil de proximité compétition (jamais généré sur ce seul critère).
  | "ATTENDANCE_LOW"
  | "GOAL_OVERDUE"
  | "PREPARATION_FORFAIT";

export interface AttentionReason {
  type: AttentionReasonType;
  value?: number;
}

export interface AthleteNeedingAttentionView {
  athlete: { id: string; firstName: string | null; lastName: string | null };
  reasons: AttentionReason[];
}

export interface UpcomingCompetitionGroupView {
  competition: {
    id: string;
    name: string;
    startDate: Date;
    city: string | null;
    country: string | null;
    level: string | null;
  };
  athleteCount: number;
  athletes: { id: string; firstName: string | null; lastName: string | null; weightCategory: string | null }[];
}

export interface GroupSummaryView {
  id: string;
  name: string;
  athleteCount: number;
  upcomingCompetitionCount: number;
  weight: { withTarget: number; aboveTarget: number; belowTarget: number; onTarget: number };
  progression: { improving: number; declining: number; unknown: number };
}

export interface DashboardSummaryCounters {
  athleteCount: number;
  groupCount: number;
  athletesWithUpcomingCompetition: number;
  athletesOnTargetWeight: number;
  athletesAboveTargetWeight: number;
  athletesBelowTargetWeight: number;
  athletesWithoutWeightTarget: number;
  athletesImproving: number;
  athletesDeclining: number;
  athletesWithoutRecentMetrics: number;
}

export interface CoachDashboardView {
  summary: DashboardSummaryCounters;
  groups: GroupSummaryView[];
  upcomingCompetitions: UpcomingCompetitionGroupView[];
  athletesNeedingAttention: AthleteNeedingAttentionView[];
  // Toujours [] pour ce ticket : aucune table d'événements n'existe, et les
  // timestamps existants (created_at/updated_at) confondraient "ligne créée
  // en base" avec "activité réelle de l'athlète" (ex. une pesée importée en
  // masse). Champ présent (pas omis) pour garder un contrat stable quand une
  // vraie source d'activité existera. Voir rapport §17.
  recentActivity: never[];
}

// ---------------------------------------------------------------------------
// Types internes (roster + regroupements batch)
// ---------------------------------------------------------------------------

interface AthleteBaseRow {
  id: string;
  categorieAge: string | null;
  grade: string | null;
  niveauSportif: string | null;
  firstName: string | null;
  lastName: string | null;
  condition: AthleteConditionView;
  wtProfile: AthleteWtProfileView | null;
}

// hasAnyMeasurement n'est jamais exposé tel quel dans ProgressionView (le
// ticket liste exactement 5 champs) : gardé à part pour NO_METRIC_DATA et
// athletesWithoutRecentMetrics, qui partagent la même définition (voir §9/§20
// du rapport final).
//
// Exportée (ticket "Dashboard groupe Coach V1" §7/§10) : CoachGroupDashboardService
// réutilise computeAll/computeBaseAttentionReasons/buildUpcomingCompetitions
// tels quels plutôt que de recalculer poids/progression/compétition depuis
// zéro pour les lignes athlète du groupe.
export interface AthleteComputed {
  base: AthleteBaseRow;
  groups: AthleteGroupRef[];
  weight: WeightSummaryView;
  progression: ProgressionView;
  hasAnyMeasurement: boolean;
  nextCompetition: NextCompetitionView | null;
  nextTraining: NextTrainingView | null;
  primaryGoal: PrimaryGoalView | null;
}

const WEIGHT_TARGET_EPSILON = 0; // voir round2 : comparaison technique post-arrondi, jamais une tolérance produit inventée

@Injectable()
export class CoachDashboardService {
  constructor(
    private readonly coachRepository: CoachRepository,
    private readonly coachGroupsRepository: CoachGroupsRepository,
    private readonly dashboardRepository: CoachDashboardRepository,
  ) {}

  async getAthleteSummaries(coachId: string, groupId?: string): Promise<AthleteDashboardSummary[]> {
    const roster = await this.resolveRoster(coachId, groupId);
    if (roster.length === 0) return [];

    const computed = await this.computeAll(coachId, roster, new Date());
    return computed.map(toAthleteDashboardSummary);
  }

  // CoachAthleteAccessGuard a déjà vérifié coach_athlete(coachId, athleteId)
  // avant d'atteindre ce service : la présence dans le roster est donc
  // garantie sauf incohérence interne, gardée en défense uniquement.
  async getAthleteDashboard(coachId: string, athleteId: string): Promise<AthleteDashboardSummary> {
    const roster = await this.resolveRoster(coachId, undefined);
    const athlete = roster.find((row) => row.id === athleteId);
    if (!athlete) {
      throw new NotFoundException(`Athlete ${athleteId} introuvable`);
    }

    const [computed] = await this.computeAll(coachId, [athlete], new Date());
    return toAthleteDashboardSummary(computed);
  }

  // Point d'entrée réutilisé par CoachGroupDashboardService (ticket
  // "Dashboard groupe Coach V1" §7) : roster ACTUEL du groupe (jamais un
  // snapshot historique — voir ticket §64, la distinction snapshot/actuel ne
  // concerne que les agrégats attendance/training, pas la liste des
  // athlètes affichés) puis exactement le même calcul batch poids/
  // progression/compétition/objectif que getAthleteSummaries, jamais
  // dupliqué. resolveRoster lève déjà ForbiddenException si le groupe
  // n'appartient pas à ce coach — défensif uniquement ici, l'appelant HTTP
  // passe par CoachGroupOwnershipGuard en amont.
  async getGroupRosterComputed(coachId: string, groupId: string): Promise<AthleteComputed[]> {
    const roster = await this.resolveRoster(coachId, groupId);
    return this.computeAll(coachId, roster, new Date());
  }

  async getDashboard(coachId: string): Promise<CoachDashboardView> {
    const roster = await this.resolveRoster(coachId, undefined);
    const now = new Date();
    const computed = await this.computeAll(coachId, roster, now);
    const groupsList = await this.coachGroupsRepository.findGroupsForCoach(coachId);

    return {
      summary: buildSummary(computed, groupsList.length),
      groups: buildGroupSummaries(groupsList, computed),
      upcomingCompetitions: buildUpcomingCompetitions(computed),
      athletesNeedingAttention: buildAttentionList(computed),
      recentActivity: [],
    };
  }

  // Filtre ?groupId (ticket §16) : le groupe doit appartenir au coach
  // connecté, jamais un coachId venant du client. 403 (jamais 404) en cas de
  // groupe inconnu ou appartenant à un autre coach, cohérent avec
  // CoachGroupOwnershipGuard (même règle, appliquée ici en service car
  // groupId est un query param, pas un :param de route sur lequel un guard
  // peut se brancher).
  private async resolveRoster(coachId: string, groupId: string | undefined): Promise<AthleteBaseRow[]> {
    const links = await this.coachRepository.findAthletesForCoach(coachId);
    const roster: AthleteBaseRow[] = links.map((link) => ({
      id: link.athlete.id,
      categorieAge: link.athlete.categorie_age,
      grade: link.athlete.grade,
      niveauSportif: link.athlete.niveau_sportif,
      firstName: link.athlete.app_user.prenom,
      lastName: link.athlete.app_user.nom,
      condition: {
        status: link.athlete.etat_forme,
        note: link.athlete.etat_forme_note,
        expectedReturn: link.athlete.etat_forme_retour ? link.athlete.etat_forme_retour.toISOString().slice(0, 10) : null,
        updatedAt: link.athlete.etat_forme_updated_at,
      },
      wtProfile: link.athlete.wt_link
        ? {
            status: link.athlete.wt_link.status,
            externalAthleteId: link.athlete.wt_link.external_athlete.id,
            displayName: link.athlete.wt_link.external_athlete.display_name,
            countryCode: link.athlete.wt_link.external_athlete.country_code,
          }
        : null,
    }));

    if (!groupId) {
      return roster;
    }

    const group = await this.dashboardRepository.findGroupWithMemberIds(groupId);
    if (!group || group.coach_id !== coachId) {
      throw new ForbiddenException("Accès interdit à ce groupe");
    }

    const memberIds = new Set(group.members.map((member) => member.athlete_id));
    return roster.filter((athlete) => memberIds.has(athlete.id));
  }

  // Point d'entrée batch unique : quel que soit le nombre d'athlètes dans
  // `roster`, ce bloc exécute un nombre CONSTANT de requêtes (voir rapport
  // §20) — jamais une boucle par athlète.
  private async computeAll(
    coachId: string,
    roster: AthleteBaseRow[],
    now: Date,
  ): Promise<AthleteComputed[]> {
    if (roster.length === 0) return [];
    const athleteIds = roster.map((a) => a.id);

    // "À venir" = à partir de minuit UTC du jour courant (competition.date_debut
    // est un DATE) : même définition que la vue Athlete, appliquée aux
    // participations ET aux préparations.
    const fromDate = todayUtcMidnight(now);

    const [
      groupLinks,
      weightLogs,
      weightTargets,
      metricTypes,
      measurements,
      upcomingParticipations,
      upcomingParticipationLinks,
      upcomingPreparations,
      upcomingTrainings,
      activeGoals,
    ] = await Promise.all([
      this.dashboardRepository.findGroupsForAthletes(athleteIds, coachId),
      this.dashboardRepository.findWeightLogsForAthletes(athleteIds),
      this.dashboardRepository.findActiveWeightTargetsForAthletes(athleteIds),
      this.dashboardRepository.findAllMetricTypes(),
      this.dashboardRepository.findMeasurementsForAthletes(athleteIds),
      this.dashboardRepository.findUpcomingParticipationsForAthletes(athleteIds, fromDate),
      this.dashboardRepository.findUpcomingParticipationLinksForAthletes(athleteIds, fromDate),
      // Préparations de CE coach uniquement (coachId dans le filtre) : jamais
      // celles d'un autre coach du même athlète.
      this.dashboardRepository.findUpcomingPreparationsForAthletes(athleteIds, coachId, fromDate),
      this.dashboardRepository.findUpcomingTrainingsForAthletes(athleteIds, now),
      this.dashboardRepository.findActiveGoalsForAthletes(athleteIds),
    ]);

    const groupsByAthlete = groupBy(groupLinks, (l) => l.athlete_id);
    const weightLogsByAthlete = groupBy(weightLogs, (l) => l.athlete_id);
    const targetByAthlete = firstByGroup(weightTargets, (t) => t.athlete_id);
    const measurementsByAthlete = groupBy(measurements, (m) => m.athlete_id);
    const upcomingParticipationsByAthlete = groupBy(upcomingParticipations, (p) => p.athlete_id);
    const participationLinksByAthlete = groupBy(upcomingParticipationLinks, (l) => l.athlete_id);
    const upcomingPreparationsByAthlete = groupBy(upcomingPreparations, (p) => p.athlete_id);
    const nextTrainingByAthlete = firstByGroup(upcomingTrainings, (t) => t.athlete_id);
    const primaryGoalByAthlete = firstByGroup(activeGoals, (g) => g.athlete_id);

    return roster.map((base) => {
      const groups = (groupsByAthlete.get(base.id) ?? []).map((l) => ({
        id: l.coach_group.id,
        name: l.coach_group.name,
      }));

      const logs = weightLogsByAthlete.get(base.id) ?? [];
      const target = targetByAthlete.get(base.id);
      const weight = buildWeightView(logs, target ?? null);

      const athleteMeasurements = measurementsByAthlete.get(base.id) ?? [];
      const { progression, hasAnyMeasurement } = buildProgression(metricTypes, athleteMeasurements);

      // Règle "prochaine compétition" UNIQUE, partagée avec la vue Athlete
      // (competitions/next-competition.ts) : participations actives +
      // préparations de ce coach, dédupliquées par compétition.
      const choice = selectNextCompetition<BatchParticipation, BatchUpcomingPreparation>({
        activeParticipations: (upcomingParticipationsByAthlete.get(base.id) ?? []).map((p) => ({
          competitionId: p.competition.id,
          startDate: p.competition.date_debut,
          value: p,
        })),
        preparations: (upcomingPreparationsByAthlete.get(base.id) ?? []).map((p) => ({
          competitionId: p.competition_id,
          startDate: p.competition.date_debut,
          status: p.statut,
          value: p,
        })),
        competitionIdsWithParticipation: new Set(
          (participationLinksByAthlete.get(base.id) ?? []).map((link) => link.competition_id),
        ),
      });
      const nextCompetition = choice ? toNextCompetitionView(choice, now) : null;

      const nextTrainingRow = nextTrainingByAthlete.get(base.id);
      const nextTraining = nextTrainingRow ? toNextTrainingView(nextTrainingRow) : null;

      const goalRow = primaryGoalByAthlete.get(base.id);
      const primaryGoal = goalRow ? toPrimaryGoalView(goalRow, now) : null;

      return { base, groups, weight, progression, hasAnyMeasurement, nextCompetition, nextTraining, primaryGoal };
    });
  }
}

// ---------------------------------------------------------------------------
// Regroupement en mémoire (aucune requête DB dans cette section)
// ---------------------------------------------------------------------------

function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

// Garde uniquement la première occurrence par clé : les tableaux d'entrée
// sont pré-triés par le repository (ex. athlete_id puis date_debut asc), donc
// "première occurrence" == "prochaine échéance" sans tri supplémentaire ici.
function firstByGroup<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T> {
  const map = new Map<K, T>();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, item);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Construction par domaine (logique pure, réutilise les fonctions partagées)
// ---------------------------------------------------------------------------

interface WeightLogRow {
  valeur_kg: { toNumber(): number };
  date_mesure: Date;
}
interface WeightTargetRow {
  poids_cible_kg: { toNumber(): number };
  date_cible: Date | null;
  competition_id: string | null;
}

// Même algorithme que WeightsService.getWeightSummary, appliqué en mémoire
// sur un historique déjà chargé (logs triés date_mesure desc) plutôt que via
// une requête ciblée par athlète — voir CoachDashboardRepository.
// computeWeightSummary (importée) reste l'unique source de vérité de la
// formule elle-même (differenceToTarget/weeklyChange).
function buildWeightView(logsDesc: WeightLogRow[], target: WeightTargetRow | null): WeightSummaryView {
  const latest = logsDesc[0] ?? null;
  const currentWeight = latest ? latest.valeur_kg.toNumber() : null;
  const measuredAt = latest ? latest.date_mesure : null;
  const targetView = target
    ? { weight: target.poids_cible_kg.toNumber(), targetDate: target.date_cible, competitionId: target.competition_id }
    : null;

  let referenceWeight: number | null = null;
  if (latest) {
    const cutoff = latest.date_mesure.getTime() - REFERENCE_WINDOW_MS;
    const reference = logsDesc.find((log) => log.date_mesure.getTime() <= cutoff);
    referenceWeight = reference ? reference.valeur_kg.toNumber() : null;
  }

  return computeWeightSummary(currentWeight, measuredAt, targetView, referenceWeight);
}

interface MeasurementRow {
  metric_type_id: string;
  valeur: { toNumber(): number };
  mesure_le: Date;
}
interface MetricTypeRow {
  id: string;
  improvement_direction: string | null;
}

// Réutilise compareMeasurements (MetricsService) telle quelle : le cas
// "Temps de réaction 420 -> 380ms = improved" est géré par cette même
// fonction déjà testée dans metrics.service.spec.ts, jamais réinterprété ici
// depuis le signe brut du delta (voir ticket §9).
function buildProgression(
  metricTypes: MetricTypeRow[],
  measurements: MeasurementRow[],
): { progression: ProgressionView; hasAnyMeasurement: boolean } {
  const byMetricType = groupBy(measurements, (m) => m.metric_type_id);

  let improvedCount = 0;
  let decliningCount = 0;
  let unknownCount = 0;
  let evaluatedCount = 0;
  let hasAnyMeasurement = false;

  for (const metricType of metricTypes) {
    const forType = byMetricType.get(metricType.id) ?? [];
    if (forType.length > 0) hasAnyMeasurement = true;

    if (forType.length < 2) {
      unknownCount++;
      continue;
    }

    // `forType` est trié mesure_le desc par le repository : [0] = actuelle.
    const current = forType[0].valeur.toNumber();
    const previous = forType[1].valeur.toNumber();
    const status = compareMeasurements(metricType.improvement_direction, current, previous);

    if (status === "unknown") {
      unknownCount++;
      continue;
    }

    evaluatedCount++;
    if (status === "improved") improvedCount++;
    else if (status === "regressed") decliningCount++;
    // "stable" : compté dans evaluatedCount uniquement, ni amélioration ni déclin.
  }

  return {
    progression: { improvedCount, decliningCount, unknownCount, evaluatedCount, overallStatus: null },
    hasAnyMeasurement,
  };
}

function toPreparationView(preparation: BatchUpcomingPreparation): NextCompetitionPreparationView {
  return {
    status: preparation.statut,
    targetAgeCategory: preparation.categorie_age_prevue,
    targetWeightCategory: preparation.categorie_poids_prevue,
  };
}

function toNextCompetitionView(
  choice: NonNullable<ReturnType<typeof selectNextCompetition<BatchParticipation, BatchUpcomingPreparation>>>,
  now: Date,
): NextCompetitionView {
  if (choice.source === "participation") {
    const { participation, preparation } = choice;
    return {
      id: participation.competition.id,
      name: participation.competition.nom,
      startDate: participation.competition.date_debut,
      city: participation.competition.ville,
      country: participation.competition.pays,
      level: participation.competition.niveau,
      weightCategory: participation.categorie_poids,
      ageCategory: participation.categorie_age,
      source: "participation",
      preparation: preparation ? toPreparationView(preparation) : null,
      daysUntil: daysUntil(participation.competition.date_debut, now),
    };
  }

  const { competition } = choice.preparation;
  return {
    id: competition.id,
    name: competition.nom,
    startDate: competition.date_debut,
    city: competition.ville,
    country: competition.pays,
    level: competition.niveau,
    // Aucune participation : pas de catégorie officielle (jamais déduite du prévu).
    weightCategory: null,
    ageCategory: null,
    source: "coach_preparation",
    preparation: toPreparationView(choice.preparation),
    daysUntil: daysUntil(competition.date_debut, now),
  };
}

interface TrainingRow {
  id: string;
  titre: string;
  date_debut: Date;
  date_fin: Date | null;
  type_seance: string | null;
}

function toNextTrainingView(training: TrainingRow): NextTrainingView {
  return {
    id: training.id,
    title: training.titre,
    startAt: training.date_debut,
    endAt: training.date_fin,
    type: training.type_seance,
  };
}

function toPrimaryGoalView(goal: BatchGoal, now: Date): PrimaryGoalView {
  const progress = computeGoalProgress(goal.goal_step);
  return {
    id: goal.id,
    title: goal.titre,
    targetDate: goal.date_cible,
    daysUntil: goal.date_cible ? daysUntil(goal.date_cible, now) : null,
    progressPercentage: progress.percentage,
    completedSteps: progress.completed,
    totalSteps: progress.total,
  };
}

function toAthleteDashboardSummary(computed: AthleteComputed): AthleteDashboardSummary {
  return {
    id: computed.base.id,
    firstName: computed.base.firstName,
    lastName: computed.base.lastName,
    ageCategory: computed.base.categorieAge,
    grade: computed.base.grade,
    sportLevel: computed.base.niveauSportif,
    condition: computed.base.condition,
    wtProfile: computed.base.wtProfile,
    groups: computed.groups,
    weight: computed.weight,
    progression: computed.progression,
    nextCompetition: computed.nextCompetition,
    nextTraining: computed.nextTraining,
    primaryGoal: computed.primaryGoal,
  };
}

// ---------------------------------------------------------------------------
// Agrégats dashboard (summary / groups / upcomingCompetitions / attention)
// ---------------------------------------------------------------------------

// "Au poids" (ticket §7) : égalité TECHNIQUE post-arrondi (le même round2 que
// differenceToTarget), jamais une tolérance produit (±0.5kg, ±1kg...)
// choisie arbitrairement. Une vraie tolérance métier reste une décision
// produit à prendre séparément.
function isOnTarget(differenceToTarget: number | null): boolean {
  return differenceToTarget !== null && differenceToTarget === WEIGHT_TARGET_EPSILON;
}

function buildSummary(computed: AthleteComputed[], groupCount: number): DashboardSummaryCounters {
  let athletesWithUpcomingCompetition = 0;
  let athletesOnTargetWeight = 0;
  let athletesAboveTargetWeight = 0;
  let athletesBelowTargetWeight = 0;
  let athletesWithoutWeightTarget = 0;
  let athletesImproving = 0;
  let athletesDeclining = 0;
  let athletesWithoutRecentMetrics = 0;

  for (const athlete of computed) {
    if (athlete.nextCompetition) athletesWithUpcomingCompetition++;

    if (athlete.weight.target === null) {
      athletesWithoutWeightTarget++;
    } else if (isOnTarget(athlete.weight.differenceToTarget)) {
      athletesOnTargetWeight++;
    } else if ((athlete.weight.differenceToTarget ?? 0) > 0) {
      athletesAboveTargetWeight++;
    } else if ((athlete.weight.differenceToTarget ?? 0) < 0) {
      athletesBelowTargetWeight++;
    }

    // Tendance nette (ticket §5) : simple, symétrique, documentée — pas une
    // règle produit validée. improvedCount == decliningCount (y compris 0/0)
    // ne compte dans aucun des deux compteurs.
    if (athlete.progression.improvedCount > athlete.progression.decliningCount) athletesImproving++;
    else if (athlete.progression.decliningCount > athlete.progression.improvedCount) athletesDeclining++;

    // "Récent" n'est défini nulle part dans le backend actuel (aucune notion
    // de fenêtre temporelle) : lu ici comme "aucune mesure historique du
    // tout", pas une fenêtre de N jours inventée. Voir rapport §5.
    if (!athlete.hasAnyMeasurement) athletesWithoutRecentMetrics++;
  }

  return {
    athleteCount: computed.length,
    groupCount,
    athletesWithUpcomingCompetition,
    athletesOnTargetWeight,
    athletesAboveTargetWeight,
    athletesBelowTargetWeight,
    athletesWithoutWeightTarget,
    athletesImproving,
    athletesDeclining,
    athletesWithoutRecentMetrics,
  };
}

interface GroupListRow {
  id: string;
  name: string;
  _count: { members: number };
}

function buildGroupSummaries(groups: GroupListRow[], computed: AthleteComputed[]): GroupSummaryView[] {
  return groups
    .map((group) => {
      const members = computed.filter((athlete) => athlete.groups.some((g) => g.id === group.id));

      let withTarget = 0;
      let aboveTarget = 0;
      let belowTarget = 0;
      let onTarget = 0;
      let improving = 0;
      let declining = 0;
      let unknown = 0;
      const upcomingCompetitionIds = new Set<string>();

      for (const member of members) {
        if (member.weight.target !== null) {
          withTarget++;
          if (isOnTarget(member.weight.differenceToTarget)) onTarget++;
          else if ((member.weight.differenceToTarget ?? 0) > 0) aboveTarget++;
          else if ((member.weight.differenceToTarget ?? 0) < 0) belowTarget++;
        }

        if (member.progression.improvedCount > member.progression.decliningCount) improving++;
        else if (member.progression.decliningCount > member.progression.improvedCount) declining++;
        else unknown++;

        if (member.nextCompetition) upcomingCompetitionIds.add(member.nextCompetition.id);
      }

      return {
        id: group.id,
        name: group.name,
        athleteCount: group._count.members,
        upcomingCompetitionCount: upcomingCompetitionIds.size,
        weight: { withTarget, aboveTarget, belowTarget, onTarget },
        progression: { improving, declining, unknown },
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

// Exportée (ticket "Dashboard groupe Coach V1" §14) : même règle de dédup
// "prochaine compétition par athlète" que le dashboard global, jamais
// réécrite pour le groupe — CoachGroupDashboardService l'appelle telle
// quelle sur le roster du groupe.
export function buildUpcomingCompetitions(computed: AthleteComputed[]): UpcomingCompetitionGroupView[] {
  const byCompetition = new Map<string, UpcomingCompetitionGroupView>();

  for (const athlete of computed) {
    const next = athlete.nextCompetition;
    if (!next) continue;

    let entry = byCompetition.get(next.id);
    if (!entry) {
      entry = {
        competition: {
          id: next.id,
          name: next.name,
          startDate: next.startDate,
          city: next.city,
          country: next.country,
          level: next.level,
        },
        athleteCount: 0,
        athletes: [],
      };
      byCompetition.set(next.id, entry);
    }

    entry.athleteCount++;
    entry.athletes.push({
      id: athlete.base.id,
      firstName: athlete.base.firstName,
      lastName: athlete.base.lastName,
      weightCategory: next.weightCategory,
    });
  }

  return [...byCompetition.values()].sort((a, b) => a.competition.startDate.getTime() - b.competition.startDate.getTime());
}

// Raisons objectivement dérivables des règles déjà établies ailleurs dans ce
// service (ticket §19). COMPETITION_SOON volontairement absent : aucun seuil
// J-7/J-14/J-30 n'est autorisé par le ticket sans décision produit ;
// `nextCompetition.daysUntil` est déjà exposé pour que le frontend applique
// son propre seuil sans qu'on lui impose une règle inventée ici.
// Exportée (ticket "Dashboard groupe Coach V1" §21) : les raisons poids +
// progression restent l'unique logique d'attention du dashboard global
// (inchangé). CoachGroupDashboardService appelle cette même fonction puis
// ajoute par-dessus ATTENDANCE_LOW/GOAL_OVERDUE/PREPARATION_FORFAIT — jamais
// une réinterprétation séparée des mêmes règles poids/métrique.
const CONDITION_REASONS: Record<string, AttentionReasonType> = {
  blesse: "CONDITION_INJURED",
  malade: "CONDITION_SICK",
  absent: "CONDITION_ABSENT",
};

export function computeBaseAttentionReasons(athlete: AthleteComputed): AttentionReason[] {
  const reasons: AttentionReason[] = [];

  // En tête : c'est l'information la plus immédiate pour le coach.
  const conditionReason = CONDITION_REASONS[athlete.base.condition.status];
  if (conditionReason) {
    reasons.push({ type: conditionReason });
  }
  if (athlete.base.wtProfile?.status === "pending") {
    reasons.push({ type: "WT_LINK_PENDING" });
  }

  if (athlete.weight.target === null) {
    reasons.push({ type: "NO_WEIGHT_TARGET" });
  } else if (athlete.weight.differenceToTarget !== null && !isOnTarget(athlete.weight.differenceToTarget)) {
    reasons.push({
      type: athlete.weight.differenceToTarget > 0 ? "WEIGHT_ABOVE_TARGET" : "WEIGHT_BELOW_TARGET",
      value: athlete.weight.differenceToTarget,
    });
  }

  if (athlete.progression.decliningCount > 0) {
    reasons.push({ type: "METRIC_DECLINING", value: athlete.progression.decliningCount });
  }
  if (!athlete.hasAnyMeasurement) {
    reasons.push({ type: "NO_METRIC_DATA" });
  }

  return reasons;
}

function buildAttentionList(computed: AthleteComputed[]): AthleteNeedingAttentionView[] {
  const result: AthleteNeedingAttentionView[] = [];

  for (const athlete of computed) {
    const reasons = computeBaseAttentionReasons(athlete);

    if (reasons.length > 0) {
      result.push({
        athlete: { id: athlete.base.id, firstName: athlete.base.firstName, lastName: athlete.base.lastName },
        reasons,
      });
    }
  }

  return result;
}
