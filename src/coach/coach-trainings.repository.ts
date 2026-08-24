import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CANCELLED_TRAINING_STATUS } from "../trainings/trainings.repository";

const SAFE_USER_SELECT = { id: true, email: true, nom: true, prenom: true } as const;

// Champs métier copiés tels quels sur chaque training_session généré — mêmes
// noms que le modèle Prisma training_session (voir schema.prisma), pour que
// la copie soit une projection triviale à auditer, jamais une transformation.
export interface TrainingFieldsSnapshot {
  titre: string;
  type_seance?: string;
  sous_type?: string;
  date_debut: Date;
  date_fin?: Date;
  lieu?: string;
  niveau?: string;
  description?: string;
}

const SESSION_LIST_SELECT = {
  id: true,
  titre: true,
  type_seance: true,
  sous_type: true,
  date_debut: true,
  date_fin: true,
  lieu: true,
  niveau: true,
  description: true,
  statut: true,
  _count: { select: { assignments: true } },
} satisfies Prisma.coach_training_sessionSelect;

const SESSION_DETAIL_SELECT = {
  id: true,
  titre: true,
  type_seance: true,
  sous_type: true,
  date_debut: true,
  date_fin: true,
  lieu: true,
  niveau: true,
  description: true,
  statut: true,
  assignments: {
    select: {
      training_session_id: true,
      athlete: { select: { id: true, app_user: { select: SAFE_USER_SELECT } } },
    },
  },
  group_sources: {
    select: { coach_group: { select: { id: true, name: true } } },
  },
} satisfies Prisma.coach_training_sessionSelect;

export type CoachTrainingSummary = Prisma.coach_training_sessionGetPayload<{ select: typeof SESSION_LIST_SELECT }>;
export type CoachTrainingDetail = Prisma.coach_training_sessionGetPayload<{ select: typeof SESSION_DETAIL_SELECT }>;

@Injectable()
export class CoachTrainingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // La résolution/autorisation des destinataires (groupes + athlètes) vit
  // désormais dans CoachDestinataireResolver (partagée avec la publication
  // d'exercices, voir ce fichier) — plus dupliquée ici depuis ce ticket.

  findOwnership(trainingSessionId: string) {
    return this.prisma.coach_training_session.findUnique({
      where: { id: trainingSessionId },
      select: { coach_id: true },
    });
  }

  findSessionsForCoach(coachId: string, range?: { from: Date; to: Date }): Promise<CoachTrainingSummary[]> {
    return this.prisma.coach_training_session.findMany({
      where: {
        coach_id: coachId,
        ...(range ? { date_debut: { gte: range.from, lte: range.to } } : {}),
      },
      select: SESSION_LIST_SELECT,
      orderBy: { date_debut: "asc" },
    });
  }

  findSessionDetail(trainingSessionId: string): Promise<CoachTrainingDetail | null> {
    return this.prisma.coach_training_session.findUnique({
      where: { id: trainingSessionId },
      select: SESSION_DETAIL_SELECT,
    });
  }

  // Création atomique : 1 create (session) + au plus 3 createMany (peu
  // importe le nombre d'athlètes assignés) — voir rapport §24 pour le compte
  // exact. Les ids training_session sont générés côté application
  // (crypto.randomUUID) pour permettre createMany (qui ne renvoie pas les
  // lignes créées côté Postgres/Prisma) tout en connaissant déjà chaque id
  // pour construire les coach_training_assignment dans la même transaction.
  async createSessionWithAssignments(
    coachId: string,
    fields: TrainingFieldsSnapshot,
    athleteIds: string[],
    groupIds: string[],
  ): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.coach_training_session.create({
        data: { coach_id: coachId, ...fields },
        select: { id: true },
      });

      const trainingSessionRows = athleteIds.map((athleteId) => ({
        id: randomUUID(),
        athlete_id: athleteId,
        ...fields,
      }));

      if (trainingSessionRows.length > 0) {
        await tx.training_session.createMany({ data: trainingSessionRows });
        await tx.coach_training_assignment.createMany({
          data: trainingSessionRows.map((row) => ({
            coach_training_session_id: session.id,
            training_session_id: row.id,
            athlete_id: row.athlete_id,
          })),
        });
      }

      if (groupIds.length > 0) {
        await tx.coach_training_group_source.createMany({
          data: groupIds.map((groupId) => ({ coach_training_session_id: session.id, group_id: groupId })),
        });
      }

      return session.id;
    });
  }

  // Propagation ticket §13 : UNE modification de contenu doit être visible
  // par tous les athlètes déjà assignés. updateMany sur training_session
  // reste O(1) requête quel que soit le nombre d'assignés (jamais une boucle
  // par athlète — voir rapport §24).
  async updateContentAndPropagate(trainingSessionId: string, fields: Partial<TrainingFieldsSnapshot>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.coach_training_session.update({ where: { id: trainingSessionId }, data: fields });

      const assignments = await tx.coach_training_assignment.findMany({
        where: { coach_training_session_id: trainingSessionId },
        select: { training_session_id: true },
      });

      if (assignments.length > 0) {
        await tx.training_session.updateMany({
          where: { id: { in: assignments.map((a) => a.training_session_id) } },
          data: fields,
        });
      }
    });
  }

  // Annulation "douce" (ticket §16 : ni statut ni endpoint DELETE
  // n'existaient jusqu'ici sur training_session — voir rapport §16 pour la
  // justification complète du choix). Écrit CANCELLED_TRAINING_STATUS
  // (jamais une chaîne "annule" redupliquée) sur la séance ET les
  // training_session déjà assignés ; INACTIVE_TRAINING_STATUSES (même
  // source) exclut déjà cette valeur côté lecture (findNextForAthlete,
  // dashboard nextTraining) sans filtrage supplémentaire à écrire.
  async cancel(trainingSessionId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.coach_training_session.update({
        where: { id: trainingSessionId },
        data: { statut: CANCELLED_TRAINING_STATUS },
      });

      const assignments = await tx.coach_training_assignment.findMany({
        where: { coach_training_session_id: trainingSessionId },
        select: { training_session_id: true },
      });
      if (assignments.length > 0) {
        await tx.training_session.updateMany({
          where: { id: { in: assignments.map((a) => a.training_session_id) } },
          data: { statut: CANCELLED_TRAINING_STATUS },
        });
      }
    });
  }

  findCurrentAssignments(trainingSessionId: string) {
    return this.prisma.coach_training_assignment.findMany({
      where: { coach_training_session_id: trainingSessionId },
      select: { athlete_id: true, training_session_id: true },
    });
  }

  // Remplacement complet transactionnel (ticket §14) : retire les
  // assignments absents du nouvel ensemble (et leur training_session
  // généré), ajoute les nouveaux, remplace intégralement les
  // group_sources. `fields` sert à générer les training_session des NOUVEAUX
  // athlètes avec le contenu ACTUEL de la séance (jamais périmé).
  async replaceAssignments(
    coachTrainingSessionId: string,
    fields: TrainingFieldsSnapshot,
    toAddAthleteIds: string[],
    toRemoveTrainingSessionIds: string[],
    newGroupIds: string[],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (toRemoveTrainingSessionIds.length > 0) {
        // onDelete: Cascade sur coach_training_assignment.training_session_id
        // : supprimer training_session suffit à retirer l'assignment associé.
        await tx.training_session.deleteMany({ where: { id: { in: toRemoveTrainingSessionIds } } });
      }

      if (toAddAthleteIds.length > 0) {
        const newRows = toAddAthleteIds.map((athleteId) => ({ id: randomUUID(), athlete_id: athleteId, ...fields }));
        await tx.training_session.createMany({ data: newRows });
        await tx.coach_training_assignment.createMany({
          data: newRows.map((row) => ({
            coach_training_session_id: coachTrainingSessionId,
            training_session_id: row.id,
            athlete_id: row.athlete_id,
          })),
        });
      }

      await tx.coach_training_group_source.deleteMany({ where: { coach_training_session_id: coachTrainingSessionId } });
      if (newGroupIds.length > 0) {
        await tx.coach_training_group_source.createMany({
          data: newGroupIds.map((groupId) => ({ coach_training_session_id: coachTrainingSessionId, group_id: groupId })),
        });
      }
    });
  }
}
