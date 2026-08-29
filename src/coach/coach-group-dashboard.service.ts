import { Injectable, NotFoundException } from "@nestjs/common";
import { CoachGroupsRepository } from "./coach-groups.repository";
import {
  AttentionReason,
  AthleteNeedingAttentionView,
  buildUpcomingCompetitions,
  computeBaseAttentionReasons,
  CoachDashboardService,
  NextCompetitionView,
  ProgressionView,
  UpcomingCompetitionGroupView,
} from "./coach-dashboard.service";
import { WeightSummaryView } from "../weights/weights.service";
import { CoachTrainingAttendanceService, GroupAttendanceCountsView, THIRTY_DAYS_MS } from "./coach-training-attendance.service";
import { CoachTrainingsRepository } from "./coach-trainings.repository";
import { CoachCompetitionPreparationsRepository, BatchPreparationWithCompetition } from "./coach-competition-preparations.repository";
import { PreparationStatus } from "./coach-competition-preparation-status";

// Ticket "Dashboard groupe Coach V1" §31 : pas de cap serveur sur la
// liste complète attention/athletes (le frontend décide de l'affichage, ex.
// "voir les N athlètes concernés") — seul le nombre de compétitions/séances
// à venir affichées est plafonné ici, pour garder la réponse légère (§42).
const MAX_UPCOMING_TRAININGS = 3;
const MAX_UPCOMING_COMPETITIONS = 10;

export interface GroupUpcomingTrainingView {
  id: string;
  title: string;
  type: string | null;
  startAt: Date;
  endAt: Date | null;
}

export interface GroupTrainingSummaryView {
  completedSessionsLast30Days: number;
  upcomingSessions: GroupUpcomingTrainingView[];
}

export interface GroupPreparationSummaryView {
  activeCount: number;
  byStatus: Partial<Record<PreparationStatus, number>>;
}

export interface GroupAthleteAttendanceView {
  recordedSessions: number;
  present: number;
  absent: number;
  excused: number;
  attendanceRate: number | null;
}

export interface GroupAthletePreparationView {
  status: string;
  competitionId: string;
  competitionName: string;
}

export interface GroupAthleteOverview {
  id: string;
  firstName: string | null;
  lastName: string | null;
  attendance30d: GroupAthleteAttendanceView;
  progression: ProgressionView;
  nextCompetition: NextCompetitionView | null;
  preparation: GroupAthletePreparationView | null;
  weight: WeightSummaryView;
  attentionReasons: AttentionReason[];
}

export interface CoachGroupDashboardView {
  group: { id: string; name: string; athleteCount: number };
  attendance: { last30Days: GroupAttendanceCountsView };
  training: GroupTrainingSummaryView;
  competitions: UpcomingCompetitionGroupView[];
  preparation: GroupPreparationSummaryView;
  attention: AthleteNeedingAttentionView[];
  athletes: GroupAthleteOverview[];
}

// Seuil validé explicitement avec l'utilisateur avant implémentation (ticket
// §23, voir rapport final) : ATTENDANCE_LOW seulement si recordedSessions >= 3
// ET attendanceRate < 70% — jamais sur un échantillon trop faible (une seule
// absence isolée ne doit jamais déclencher "à surveiller").
const ATTENDANCE_LOW_MIN_RECORDED = 3;
const ATTENDANCE_LOW_RATE_THRESHOLD = 0.7;

// Orchestrateur pur (ticket §5-7) : agrège CoachDashboardService (poids/
// progression/compétition/objectif, déjà batch et group-filtrable),
// CoachTrainingAttendanceService (présence, ticket #8), CoachTrainingsRepository
// (séances) et CoachCompetitionPreparationsRepository (ticket #7) — aucune
// requête Prisma directe ici, aucune règle métier poids/progression
// recalculée. Nombre de requêtes constant indépendant du nombre d'athlètes
// (voir coach-group-dashboard.performance.spec.ts).
@Injectable()
export class CoachGroupDashboardService {
  constructor(
    private readonly coachGroupsRepository: CoachGroupsRepository,
    private readonly coachDashboardService: CoachDashboardService,
    private readonly attendanceService: CoachTrainingAttendanceService,
    private readonly coachTrainingsRepository: CoachTrainingsRepository,
    private readonly preparationsRepository: CoachCompetitionPreparationsRepository,
  ) {}

  async getGroupDashboard(coachId: string, groupId: string): Promise<CoachGroupDashboardView> {
    const now = new Date();
    const from30 = new Date(now.getTime() - THIRTY_DAYS_MS);

    // roster ACTUEL (ticket §64) : la liste d'athlètes affichée reflète la
    // composition du groupe AUJOURD'HUI, jamais un instantané passé.
    const [groupRow, roster] = await Promise.all([
      this.coachGroupsRepository.findNameForCoach(groupId),
      this.coachDashboardService.getGroupRosterComputed(coachId, groupId),
    ]);

    if (!groupRow) {
      // Défensif : CoachGroupOwnershipGuard a déjà résolu ce groupe avant
      // d'atteindre ce service.
      throw new NotFoundException(`Groupe ${groupId} introuvable`);
    }

    const athleteIds = roster.map((r) => r.base.id);

    // Agrégats historiques du GROUPE (snapshot, jamais coach_group_athlete
    // actuel — ticket §8/§63-64) + agrégats du roster ACTUEL, tous en
    // parallèle, tous à nombre de requêtes constant.
    const [groupAttendance, athleteAttendanceByAthlete, completedSessionsLast30Days, upcomingSessions, preparations] =
      await Promise.all([
        this.attendanceService.getGroupSummary(coachId, groupId),
        this.attendanceService.getAthleteSummaryBatch(coachId, athleteIds),
        this.coachTrainingsRepository.countCompletedSessionsForGroup(coachId, groupId, from30, now),
        this.coachTrainingsRepository.findUpcomingSessionsForGroup(coachId, groupId, now, MAX_UPCOMING_TRAININGS),
        this.preparationsRepository.findForAthletesWithCompetition(athleteIds, coachId),
      ]);

    // Préparation "active" = pour une compétition future uniquement (ticket
    // §15) — une préparation pour une compétition déjà passée n'a plus sa
    // place dans un résumé "en préparation".
    const upcomingPreparations = preparations.filter((p) => p.competition.date_debut.getTime() >= now.getTime());
    const preparationByAthlete = pickNearestPerAthlete(upcomingPreparations);
    const forfeitAthleteIds = new Set(upcomingPreparations.filter((p) => p.statut === "forfait").map((p) => p.athlete_id));

    // "Uniquement selon les statuts réellement présents" (ticket §15) :
    // Partial<Record<...>>, jamais une entrée à 0 ajoutée artificiellement.
    const byStatus: Partial<Record<PreparationStatus, number>> = {};
    for (const p of upcomingPreparations) {
      byStatus[p.statut as PreparationStatus] = (byStatus[p.statut as PreparationStatus] ?? 0) + 1;
    }

    const athletes: GroupAthleteOverview[] = roster.map((computed) => {
      const attendanceCounts = athleteAttendanceByAthlete.get(computed.base.id) ?? {
        eligibleSessions: 0,
        recordedSessions: 0,
        present: 0,
        absent: 0,
        excused: 0,
        attendanceRate: null,
      };

      const reasons = [...computeBaseAttentionReasons(computed)];

      if (
        attendanceCounts.recordedSessions >= ATTENDANCE_LOW_MIN_RECORDED &&
        attendanceCounts.attendanceRate !== null &&
        attendanceCounts.attendanceRate < ATTENDANCE_LOW_RATE_THRESHOLD
      ) {
        reasons.push({ type: "ATTENDANCE_LOW", value: attendanceCounts.attendanceRate });
      }

      if (computed.primaryGoal?.targetDate && computed.primaryGoal.targetDate.getTime() < now.getTime()) {
        reasons.push({ type: "GOAL_OVERDUE" });
      }

      if (forfeitAthleteIds.has(computed.base.id)) {
        reasons.push({ type: "PREPARATION_FORFAIT" });
      }

      const preparation = preparationByAthlete.get(computed.base.id);

      return {
        id: computed.base.id,
        firstName: computed.base.firstName,
        lastName: computed.base.lastName,
        attendance30d: {
          recordedSessions: attendanceCounts.recordedSessions,
          present: attendanceCounts.present,
          absent: attendanceCounts.absent,
          excused: attendanceCounts.excused,
          attendanceRate: attendanceCounts.attendanceRate,
        },
        progression: computed.progression,
        nextCompetition: computed.nextCompetition,
        preparation: preparation
          ? { status: preparation.statut, competitionId: preparation.competition.id, competitionName: preparation.competition.nom }
          : null,
        weight: computed.weight,
        attentionReasons: reasons,
      };
    });

    const attention: AthleteNeedingAttentionView[] = athletes
      .filter((a) => a.attentionReasons.length > 0)
      .map((a) => ({
        athlete: { id: a.id, firstName: a.firstName, lastName: a.lastName },
        reasons: a.attentionReasons,
      }));

    return {
      group: { id: groupRow.id, name: groupRow.name, athleteCount: roster.length },
      attendance: groupAttendance,
      training: {
        completedSessionsLast30Days,
        upcomingSessions: upcomingSessions.map((s) => ({
          id: s.id,
          title: s.titre,
          type: s.type_seance,
          startAt: s.date_debut,
          endAt: s.date_fin,
        })),
      },
      competitions: buildUpcomingCompetitions(roster).slice(0, MAX_UPCOMING_COMPETITIONS),
      preparation: { activeCount: upcomingPreparations.length, byStatus },
      attention,
      athletes,
    };
  }
}

// Une préparation par athlète (celle de la compétition la plus proche),
// même politique que primaryGoal/nextCompetition dans CoachDashboardService
// (firstByGroup) : les préparations sont déjà triées par date de compétition
// croissante par le repository ? Non — trié ici explicitement, ticket §7
// n'impose qu'UNE préparation affichée par ligne athlète.
function pickNearestPerAthlete(preparations: BatchPreparationWithCompetition[]): Map<string, BatchPreparationWithCompetition> {
  const sorted = [...preparations].sort((a, b) => a.competition.date_debut.getTime() - b.competition.date_debut.getTime());
  const map = new Map<string, BatchPreparationWithCompetition>();
  for (const p of sorted) {
    if (!map.has(p.athlete_id)) map.set(p.athlete_id, p);
  }
  return map;
}
