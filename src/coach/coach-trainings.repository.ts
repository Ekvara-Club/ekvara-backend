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

  // Ticket "Dashboard groupe Coach V1" §12 : "réalisée" = date_debut passée
  // ET statut non annulé (même exclusion que INACTIVE_TRAINING_STATUSES
  // ailleurs dans le projet), filtré via assignments.group_id (snapshot au
  // moment de CHAQUE séance, jamais coach_group_athlete) — un athlète retiré
  // du groupe depuis reste compté pour une séance passée où il a réellement
  // été assigné via ce groupe (ticket §63-64). `some` suffit : compte la
  // séance collective une fois, indépendamment du nombre d'athlètes assignés
  // via ce groupe.
  countCompletedSessionsForGroup(coachId: string, groupId: string, from: Date, to: Date): Promise<number> {
    return this.prisma.coach_training_session.count({
      where: {
        coach_id: coachId,
        statut: { not: CANCELLED_TRAINING_STATUS },
        date_debut: { gte: from, lt: to },
        assignments: { some: { group_id: groupId } },
      },
    });
  }

  // "À venir" (ticket §13, max 3 imposé côté service) : mêmes assignments
  // déjà snapshottés à la création de la séance (qu'elle soit passée ou
  // future ne change rien au mécanisme, voir schema.prisma) — pas de requête
  // séparée "current vs snapshot" nécessaire pour le futur.
  findUpcomingSessionsForGroup(coachId: string, groupId: string, from: Date, limit: number) {
    return this.prisma.coach_training_session.findMany({
      where: {
        coach_id: coachId,
        statut: { not: CANCELLED_TRAINING_STATUS },
        date_debut: { gte: from },
        assignments: { some: { group_id: groupId } },
      },
      select: { id: true, titre: true, type_seance: true, date_debut: true, date_fin: true },
      orderBy: { date_debut: "asc" },
      take: limit,
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
  // athletes porte le libellé de groupe snapshotté (ticket "Présences Coach
  // V1" §6/§19) : groupId = le groupe ayant réellement produit cet athlète
  // à la résolution (premier trouvé si plusieurs, arbitraire — c'est un
  // libellé, pas une autorisation), null si assignation individuelle.
  async createSessionWithAssignments(
    coachId: string,
    fields: TrainingFieldsSnapshot,
    athletes: { athleteId: string; groupId: string | null }[],
    groupIds: string[],
  ): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.coach_training_session.create({
        data: { coach_id: coachId, ...fields },
        select: { id: true },
      });

      const trainingSessionRows = athletes.map((a) => ({
        id: randomUUID(),
        athlete_id: a.athleteId,
        ...fields,
      }));

      if (trainingSessionRows.length > 0) {
        await tx.training_session.createMany({ data: trainingSessionRows });
        await tx.coach_training_assignment.createMany({
          data: trainingSessionRows.map((row, i) => ({
            coach_training_session_id: session.id,
            training_session_id: row.id,
            athlete_id: row.athlete_id,
            group_id: athletes[i].groupId,
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

  // Ticket "Présences Coach V1" §3/§15 : un retrait d'assignation qui
  // détruirait (cascade) une présence déjà enregistrée doit être refusé
  // explicitement plutôt que de silencieusement effacer un historique.
  // Lu juste avant le transaction de replaceAssignments — pas de
  // verrouillage supplémentaire nécessaire, la fenêtre de concurrence
  // (créer une présence entre cette lecture et le retrait) reste couverte
  // par la contrainte FK Cascade elle-même : au pire cas elle disparaît
  // réellement, mais c'est un scénario de double-action coach quasi
  // inexistant en pratique et déjà hors du périmètre V1 documenté.
  findAttendanceForTrainingSessions(trainingSessionIds: string[]) {
    if (trainingSessionIds.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.training_attendance.findMany({
      where: { training_session_id: { in: trainingSessionIds } },
      select: { training_session_id: true },
    });
  }

  // Remplacement complet transactionnel (ticket §14) : retire les
  // assignments absents du nouvel ensemble (et leur training_session
  // généré), ajoute les nouveaux, remplace intégralement les
  // group_sources. `fields` sert à générer les training_session des NOUVEAUX
  // athlètes avec le contenu ACTUEL de la séance (jamais périmé). toAdd
  // porte le même libellé de groupe snapshotté que createSessionWithAssignments.
  async replaceAssignments(
    coachTrainingSessionId: string,
    fields: TrainingFieldsSnapshot,
    toAdd: { athleteId: string; groupId: string | null }[],
    toRemoveTrainingSessionIds: string[],
    newGroupIds: string[],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (toRemoveTrainingSessionIds.length > 0) {
        // onDelete: Cascade sur coach_training_assignment.training_session_id
        // : supprimer training_session suffit à retirer l'assignment associé.
        // (Le service a déjà vérifié via findAttendanceForTrainingSessions
        // qu'aucune de ces sessions n'a de présence enregistrée avant
        // d'appeler cette méthode — voir CoachTrainingsService.replaceAssignments.)
        await tx.training_session.deleteMany({ where: { id: { in: toRemoveTrainingSessionIds } } });
      }

      if (toAdd.length > 0) {
        const newRows = toAdd.map((a) => ({ id: randomUUID(), athlete_id: a.athleteId, ...fields }));
        await tx.training_session.createMany({ data: newRows });
        await tx.coach_training_assignment.createMany({
          data: newRows.map((row, i) => ({
            coach_training_session_id: coachTrainingSessionId,
            training_session_id: row.id,
            athlete_id: row.athlete_id,
            group_id: toAdd[i].groupId,
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
