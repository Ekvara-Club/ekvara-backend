import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { CoachTrainingAttendanceRepository } from "./coach-training-attendance.repository";
import { PutCoachTrainingAttendanceDto } from "./dto/put-coach-training-attendance.dto";
import { CANCELLED_TRAINING_STATUS } from "../trainings/trainings.repository";

// Exportée (ticket "Dashboard groupe Coach V1" §11) : même fenêtre 30 jours
// réutilisée par CoachGroupDashboardService pour le résumé "séances" du
// groupe, jamais une seconde constante dupliquée.
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class CoachTrainingAttendanceService {
  constructor(private readonly repository: CoachTrainingAttendanceRepository) {}

  async getAttendanceSheet(trainingId: string) {
    const session = await this.repository.findSessionWithRoster(trainingId);
    if (!session) {
      // Défensif : CoachTrainingOwnershipGuard a déjà résolu cette séance.
      throw new NotFoundException(`Séance ${trainingId} introuvable`);
    }
    return toAttendanceSheetView(session);
  }

  async putAttendance(trainingId: string, dto: PutCoachTrainingAttendanceDto) {
    const session = await this.repository.findSessionWithRoster(trainingId);
    if (!session) {
      throw new NotFoundException(`Séance ${trainingId} introuvable`);
    }

    // Ticket §8/§41 : jamais côté client seul. Séance annulée -> refusée
    // explicitement (ticket §9), même si elle est aussi dans le passé.
    if (session.statut === CANCELLED_TRAINING_STATUS) {
      throw new ConflictException("Impossible d'enregistrer une présence : cette séance est annulée.");
    }
    // "Future" = pas encore commencée (date_debut réelle, jamais celle du
    // client). Une séance en cours ou terminée reste modifiable.
    if (session.date_debut.getTime() > Date.now()) {
      throw new ConflictException("Impossible d'enregistrer une présence avant le début réel de la séance.");
    }

    const assignedByAthlete = new Map(session.assignments.map((a) => [a.athlete_id, a.training_session_id]));

    const unassigned = dto.attendances.filter((entry) => !assignedByAthlete.has(entry.athleteId));
    if (unassigned.length > 0) {
      // Ticket §13/§37 : même appartenant au roster général du coach, un
      // athlète non assigné à CETTE séance précise est refusé — jamais une
      // injection d'athleteId arbitraire, même issu du roster.
      throw new BadRequestException(
        `Un ou plusieurs athlètes ne sont pas assignés à cette séance : ${unassigned.map((u) => u.athleteId).join(", ")}`,
      );
    }

    await this.repository.upsertBatch(
      dto.attendances.map((entry) => ({
        trainingSessionId: assignedByAthlete.get(entry.athleteId)!,
        athleteId: entry.athleteId,
        status: entry.status,
        note: entry.note,
      })),
    );

    return this.getAttendanceSheet(trainingId);
  }

  async getAthleteSummary(coachId: string, athleteId: string) {
    const to = new Date();
    const from = new Date(to.getTime() - THIRTY_DAYS_MS);
    const sessions = await this.repository.findEligibleSessionsForSummary(coachId, athleteId, from, to, CANCELLED_TRAINING_STATUS);
    return { last30Days: computeAttendanceCounts(sessions) };
  }

  // Batch, jamais une requête par athlète (ticket "Dashboard groupe Coach
  // V1" §10/§38) : réutilise EXACTEMENT computeAttendanceCounts pour
  // garantir le même pourcentage qu'AthleteDetail à période équivalente —
  // jamais une formule recalculée séparément pour la page groupe.
  async getAthleteSummaryBatch(coachId: string, athleteIds: string[]): Promise<Map<string, AttendanceCountsView>> {
    if (athleteIds.length === 0) return new Map();
    const to = new Date();
    const from = new Date(to.getTime() - THIRTY_DAYS_MS);
    const sessions = await this.repository.findEligibleSessionsForSummaryBatch(coachId, athleteIds, from, to, CANCELLED_TRAINING_STATUS);

    const byAthlete = new Map<string, { training_attendance: { status: string }[] }[]>();
    for (const session of sessions) {
      const list = byAthlete.get(session.athlete_id);
      if (list) list.push(session);
      else byAthlete.set(session.athlete_id, [session]);
    }

    const result = new Map<string, AttendanceCountsView>();
    for (const athleteId of athleteIds) {
      result.set(athleteId, computeAttendanceCounts(byAthlete.get(athleteId) ?? []));
    }
    return result;
  }

  // Rollup GROUPE (ticket §8-9) : basé sur coach_training_assignment.group_id
  // (snapshot au moment de chaque séance, ticket Présences Coach V1 §6/§19),
  // jamais sur coach_group_athlete (composition ACTUELLE) — un athlète
  // retiré du groupe depuis continue de compter dans ce résumé historique
  // pour les séances où il était réellement assigné (ticket §63-64).
  // eligibleAttendances/recordedAttendances (pluriel, paires athlète×séance)
  // plutôt que eligibleSessions/recordedSessions : chaque training_session
  // est déjà une paire unique (athlète, séance) — voir schema.prisma. Type de
  // sortie distinct de AttendanceCountsView (noms de champs différents,
  // jamais un cast qui masquerait un vrai renommage).
  async getGroupSummary(coachId: string, groupId: string): Promise<{ last30Days: GroupAttendanceCountsView }> {
    const to = new Date();
    const from = new Date(to.getTime() - THIRTY_DAYS_MS);
    const pairs = await this.repository.findGroupEligibleAttendancePairs(coachId, groupId, from, to, CANCELLED_TRAINING_STATUS);
    const counts = computeAttendanceCounts(pairs);
    return {
      last30Days: {
        eligibleAttendances: counts.eligibleSessions,
        recordedAttendances: counts.recordedSessions,
        present: counts.present,
        absent: counts.absent,
        excused: counts.excused,
        attendanceRate: counts.attendanceRate,
      },
    };
  }
}

export interface GroupAttendanceCountsView {
  eligibleAttendances: number;
  recordedAttendances: number;
  present: number;
  absent: number;
  excused: number;
  attendanceRate: number | null;
}

export interface AttendanceCountsView {
  eligibleSessions: number;
  recordedSessions: number;
  present: number;
  absent: number;
  excused: number;
  attendanceRate: number | null;
}

// Formule UNIQUE (ticket "Dashboard groupe Coach V1" §10, CRITIQUE) :
// AthleteDetail (getAthleteSummary), la ligne athlète du groupe
// (getAthleteSummaryBatch) et le rollup groupe (getGroupSummary,
// noms de champs adaptés en pluriel ensuite) appellent tous cette même
// fonction pure — jamais une réécriture séparée du dénominateur/numérateur.
function computeAttendanceCounts(sessions: { training_attendance: { status: string }[] }[]): AttendanceCountsView {
  const eligibleSessions = sessions.length;
  // Une séance a au plus une présence (contrainte unique
  // training_session_id+athlete_id, training_session_id déjà unique par
  // assignment) : [0] plutôt qu'une agrégation supplémentaire.
  const recorded = sessions.filter((s) => s.training_attendance.length > 0).map((s) => s.training_attendance[0].status);
  const recordedSessions = recorded.length;
  const present = recorded.filter((status) => status === "present").length;
  const absent = recorded.filter((status) => status === "absent").length;
  const excused = recorded.filter((status) => status === "excuse").length;

  return {
    eligibleSessions,
    recordedSessions,
    present,
    absent,
    excused,
    // Ticket §28/§29, décision explicite documentée : le dénominateur est
    // recordedSessions (jamais eligibleSessions) — une séance non encore
    // renseignée ne doit jamais pénaliser artificiellement le taux. excused
    // est exclu du numérateur (ni présence ni absence).
    attendanceRate: recordedSessions > 0 ? present / recordedSessions : null,
  };
}

function toAttendanceSheetView(session: NonNullable<Awaited<ReturnType<CoachTrainingAttendanceRepository["findSessionWithRoster"]>>>) {
  return {
    training: {
      id: session.id,
      title: session.titre,
      type: session.type_seance,
      startAt: session.date_debut,
      endAt: session.date_fin,
      status: session.statut,
    },
    athletes: session.assignments.map((a) => {
      // 0 ou 1 ligne (contrainte unique) : jamais "absent" par défaut si
      // l'array est vide (ticket §21, CRITIQUE : non renseigné != absent).
      const attendance = a.training_session.training_attendance[0] ?? null;
      return {
        athleteId: a.athlete.id,
        firstName: a.athlete.app_user.prenom,
        lastName: a.athlete.app_user.nom,
        groupName: a.coach_group?.name ?? null,
        attendance: attendance ? { status: attendance.status, note: attendance.note, recordedAt: attendance.updated_at } : null,
      };
    }),
  };
}
