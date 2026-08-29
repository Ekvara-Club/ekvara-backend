import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

const SESSION_WITH_ROSTER_SELECT = {
  id: true,
  titre: true,
  type_seance: true,
  date_debut: true,
  date_fin: true,
  statut: true,
  assignments: {
    select: {
      athlete_id: true,
      training_session_id: true,
      coach_group: { select: { id: true, name: true } },
      athlete: { select: { id: true, app_user: { select: { prenom: true, nom: true } } } },
      training_session: { select: { training_attendance: { select: { status: true, note: true, updated_at: true } } } },
    },
  },
} as const;

@Injectable()
export class CoachTrainingAttendanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Une seule requête porte à la fois les infos séance ET le roster complet
  // assigné (snapshot via coach_training_assignment, jamais coach_group_athlete
  // — voir ticket §6) avec la présence déjà enregistrée si elle existe
  // (training_attendance via training_session, 0 ou 1 ligne). Pas de N+1 :
  // le roster d'une séance de 40 athlètes reste 1 aller-retour DB.
  findSessionWithRoster(coachTrainingSessionId: string) {
    return this.prisma.coach_training_session.findUnique({
      where: { id: coachTrainingSessionId },
      select: SESSION_WITH_ROSTER_SELECT,
    });
  }

  findAssignedTrainingSessionIds(coachTrainingSessionId: string) {
    return this.prisma.coach_training_assignment.findMany({
      where: { coach_training_session_id: coachTrainingSessionId },
      select: { athlete_id: true, training_session_id: true },
    });
  }

  // Batch upsert transactionnel (ticket §11/§45/§46) : un upsert par athlète
  // sur la contrainte unique (training_session_id, athlete_id), jamais un
  // delete-all-puis-recreate qui détruirait created_at/updated_at
  // inutilement pour les athlètes déjà renseignés. Regroupés dans un seul
  // $transaction (tableau de promesses Prisma) : la feuille de présence
  // d'une séance de 40 athlètes reste une seule transaction Postgres.
  async upsertBatch(entries: { trainingSessionId: string; athleteId: string; status: string; note?: string }[]): Promise<void> {
    if (entries.length === 0) return;
    await this.prisma.$transaction(
      entries.map((entry) =>
        this.prisma.training_attendance.upsert({
          where: { training_session_id_athlete_id: { training_session_id: entry.trainingSessionId, athlete_id: entry.athleteId } },
          update: { status: entry.status, note: entry.note },
          create: {
            training_session_id: entry.trainingSessionId,
            athlete_id: entry.athleteId,
            status: entry.status,
            note: entry.note,
          },
        }),
      ),
    );
  }

  // Résumé 30 jours (ticket §27-29) : uniquement les séances RÉELLEMENT
  // programmées par CE coach pour cet athlète (coach_training_assignment ->
  // coach_training_session.coach_id = coachId, jamais un training_session
  // créé librement par l'athlète lui-même via POST /athletes/:id/trainings,
  // hors périmètre de la présence coach) — isolation multi-coach identique
  // au reste du projet : un autre coach partageant cet athlète ne doit
  // jamais influencer ce résumé. `statut != annule` exclut les séances
  // annulées de eligibleSessions (ticket §9/§28). Une seule requête, pas de
  // N+1 par séance.
  findEligibleSessionsForSummary(coachId: string, athleteId: string, from: Date, to: Date, cancelledStatus: string) {
    return this.prisma.training_session.findMany({
      where: {
        athlete_id: athleteId,
        statut: { not: cancelledStatus },
        date_debut: { gte: from, lte: to },
        coach_training_assignment: { coach_training_session: { coach_id: coachId } },
      },
      select: { id: true, training_attendance: { select: { status: true } } },
    });
  }

  // Batch, jamais une requête par athlète (ticket "Dashboard groupe Coach
  // V1" §10/§38) : même filtre que findEligibleSessionsForSummary
  // (statut/fenêtre/isolation coach), athlete_id ajouté au select pour
  // regrouper le résultat multi-athlètes en mémoire (CoachTrainingAttendanceService).
  findEligibleSessionsForSummaryBatch(coachId: string, athleteIds: string[], from: Date, to: Date, cancelledStatus: string) {
    if (athleteIds.length === 0) return Promise.resolve([]);
    return this.prisma.training_session.findMany({
      where: {
        athlete_id: { in: athleteIds },
        statut: { not: cancelledStatus },
        date_debut: { gte: from, lte: to },
        coach_training_assignment: { coach_training_session: { coach_id: coachId } },
      },
      select: { id: true, athlete_id: true, training_attendance: { select: { status: true } } },
    });
  }

  // Rollup GROUPE (ticket §8-9/§63-64) : filtre sur
  // coach_training_assignment.group_id, PAS sur athlete_id/coach_group_athlete
  // — chaque training_session retourné EST déjà une paire (athlète, séance)
  // au sens du schéma (une ligne training_session par athlète assigné), donc
  // ce résultat sert directement de base à eligibleAttendances/
  // recordedAttendances (voir CoachTrainingAttendanceService.getGroupSummary).
  // Capture le groupe TEL QU'IL ÉTAIT au moment de chaque séance : un
  // athlète retiré du groupe depuis reste compté pour les séances passées où
  // il était réellement assigné via ce groupe.
  findGroupEligibleAttendancePairs(coachId: string, groupId: string, from: Date, to: Date, cancelledStatus: string) {
    return this.prisma.training_session.findMany({
      where: {
        statut: { not: cancelledStatus },
        date_debut: { gte: from, lte: to },
        coach_training_assignment: { group_id: groupId, coach_training_session: { coach_id: coachId } },
      },
      select: { id: true, training_attendance: { select: { status: true } } },
    });
  }
}
