import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CANCELLED_TRAINING_STATUS } from "../trainings/trainings.repository";
import { NotificationsRepository } from "../notifications/notifications.repository";
import { formatTrainingDateTime, NotificationInsertRow } from "../notifications/notifications.util";
import { TRAINING_ASSIGNED, TRAINING_CANCELLED, TRAINING_UPDATED, TRAINING_RESOURCE } from "../notifications/notification.constants";

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
  series_id: true,
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
  series_id: true,
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

// Texte de la notification unique d'une série, déjà rédigé côté service
// (CoachTrainingsService.createSeries) — le repository ne fait que l'insérer.
export interface SeriesNotificationContent {
  actorUserId: string;
  title: string;
  message: string;
}

// Contenu déjà décidé côté service (CoachTrainingsService), jamais recalculé
// ici : notify === null signifie "pas de changement significatif détecté"
// (ticket "IDEMPOTENCE") — aucune notification n'est insérée dans ce cas.
export interface TrainingUpdateNotify {
  actorUserId: string;
  snapshot: TrainingFieldsSnapshot;
}

@Injectable()
export class CoachTrainingsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsRepository,
  ) {}

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
  //
  // Ticket "Notifications in-app Coach + Athlete V1" : une notification
  // TRAINING_ASSIGNED par athlète nouvellement assigné, insérée DANS cette
  // même transaction (mutation + notification réussissent ou rien, voir
  // ticket "TRANSACTIONS") — jamais une boucle par athlète (createMany, même
  // politique que le reste de cette méthode, voir ticket "BATCH INSERT").
  async createSessionWithAssignments(
    coachId: string,
    fields: TrainingFieldsSnapshot,
    athletes: { athleteId: string; groupId: string | null }[],
    groupIds: string[],
    actorUserId: string,
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

        await this.notifyAssigned(tx, actorUserId, fields, trainingSessionRows);
      }

      if (groupIds.length > 0) {
        await tx.coach_training_group_source.createMany({
          data: groupIds.map((groupId) => ({ coach_training_session_id: session.id, group_id: groupId })),
        });
      }

      return session.id;
    });
  }

  // Série récurrente : N séances collectives (une par occurrence, même
  // series_id) créées dans UNE transaction, chacune avec exactement la même
  // structure qu'une séance isolée (training_session + assignment par
  // athlète, group_sources) — le planning, les présences, la modification et
  // l'annulation séance par séance fonctionnent donc sans aucun cas
  // particulier. Nombre de requêtes constant quel que soit le nombre
  // d'occurrences ou d'athlètes (4 createMany + notifications).
  //
  // Notification : UNE par athlète pour toute la série (décision ticket,
  // jamais une par occurrence), resource_id = son training_session de la
  // PREMIÈRE occurrence (deep-link vers la séance la plus proche).
  async createSeriesWithAssignments(
    coachId: string,
    seriesId: string,
    occurrences: TrainingFieldsSnapshot[],
    athletes: { athleteId: string; groupId: string | null }[],
    groupIds: string[],
    notify: SeriesNotificationContent,
  ): Promise<string[]> {
    return this.prisma.$transaction(
      async (tx) => {
        const sessionRows = occurrences.map((fields) => ({
          id: randomUUID(),
          coach_id: coachId,
          series_id: seriesId,
          ...fields,
        }));
        await tx.coach_training_session.createMany({ data: sessionRows });

        const trainingSessionRows = sessionRows.flatMap((session, occurrenceIndex) =>
          athletes.map((a) => ({
            id: randomUUID(),
            athlete_id: a.athleteId,
            group_id: a.groupId,
            coach_training_session_id: session.id,
            occurrenceIndex,
            fields: occurrences[occurrenceIndex],
          })),
        );

        if (trainingSessionRows.length > 0) {
          await tx.training_session.createMany({
            data: trainingSessionRows.map((row) => ({ id: row.id, athlete_id: row.athlete_id, ...row.fields })),
          });
          await tx.coach_training_assignment.createMany({
            data: trainingSessionRows.map((row) => ({
              coach_training_session_id: row.coach_training_session_id,
              training_session_id: row.id,
              athlete_id: row.athlete_id,
              group_id: row.group_id,
            })),
          });

          const firstOccurrenceRows = trainingSessionRows
            .filter((row) => row.occurrenceIndex === 0)
            .map((row) => ({ training_session_id: row.id, athlete_id: row.athlete_id }));
          const userIdByAthleteId = await this.resolveUserIds(
            tx,
            firstOccurrenceRows.map((r) => r.athlete_id),
          );
          await this.notifications.createMany(
            tx,
            this.buildRows(firstOccurrenceRows, userIdByAthleteId, { ...notify, type: TRAINING_ASSIGNED }),
          );
        }

        if (groupIds.length > 0) {
          await tx.coach_training_group_source.createMany({
            data: sessionRows.flatMap((session) =>
              groupIds.map((groupId) => ({ coach_training_session_id: session.id, group_id: groupId })),
            ),
          });
        }

        return sessionRows.map((row) => row.id);
      },
      // Jusqu'à ~365 occurrences (7 jours sur 1 an) × N athlètes : plus de
      // lignes qu'une séance isolée, même nombre de requêtes — marge au-delà
      // des 5 s par défaut d'une transaction interactive Prisma.
      { timeout: 20_000 },
    );
  }

  // Propriétaire d'une série : n'importe quelle occurrence suffit (toutes
  // partagent le même coach_id, posé à la création). null = série inconnue.
  findSeriesOwnership(seriesId: string) {
    return this.prisma.coach_training_session.findFirst({
      where: { series_id: seriesId },
      select: { coach_id: true },
    });
  }

  // "Annuler la suite" : toutes les occurrences de la série qui commencent
  // STRICTEMENT après `now` et ne sont pas déjà annulées — jamais une séance
  // passée ou en cours (historique et présences intacts). Même écriture que
  // cancel() (CANCELLED_TRAINING_STATUS sur la séance coach ET ses
  // training_session), mais UNE notification par athlète pour l'ensemble,
  // resource_id = sa première séance annulée. Rejouer l'appel ne trouve plus
  // rien à annuler : 0 annulation, aucune notification (idempotent).
  async cancelUpcomingInSeries(
    seriesId: string,
    now: Date,
    actorUserId: string,
  ): Promise<{ cancelledCount: number }> {
    return this.prisma.$transaction(async (tx) => {
      const upcoming = await tx.coach_training_session.findMany({
        where: {
          series_id: seriesId,
          date_debut: { gt: now },
          OR: [{ statut: null }, { statut: { not: CANCELLED_TRAINING_STATUS } }],
        },
        select: { id: true, titre: true, date_debut: true },
        orderBy: { date_debut: "asc" },
      });
      if (upcoming.length === 0) {
        return { cancelledCount: 0 };
      }

      const sessionIds = upcoming.map((s) => s.id);
      await tx.coach_training_session.updateMany({
        where: { id: { in: sessionIds } },
        data: { statut: CANCELLED_TRAINING_STATUS },
      });

      const assignments = await tx.coach_training_assignment.findMany({
        where: { coach_training_session_id: { in: sessionIds } },
        select: { training_session_id: true, athlete_id: true, coach_training_session_id: true },
      });
      if (assignments.length > 0) {
        await tx.training_session.updateMany({
          where: { id: { in: assignments.map((a) => a.training_session_id) } },
          data: { statut: CANCELLED_TRAINING_STATUS },
        });

        // Première séance annulée de chaque athlète (upcoming est trié).
        const orderBySession = new Map(sessionIds.map((id, index) => [id, index]));
        const firstByAthlete = new Map<string, { training_session_id: string; athlete_id: string; order: number }>();
        for (const a of assignments) {
          const order = orderBySession.get(a.coach_training_session_id) ?? Number.MAX_SAFE_INTEGER;
          const current = firstByAthlete.get(a.athlete_id);
          if (!current || order < current.order) {
            firstByAthlete.set(a.athlete_id, { training_session_id: a.training_session_id, athlete_id: a.athlete_id, order });
          }
        }
        const recipients = [...firstByAthlete.values()];
        const userIdByAthleteId = await this.resolveUserIds(
          tx,
          recipients.map((r) => r.athlete_id),
        );
        const first = upcoming[0];
        const count = upcoming.length;
        const rows = this.buildRows(recipients, userIdByAthleteId, {
          actorUserId,
          type: TRAINING_CANCELLED,
          title: "Entraînements annulés",
          message:
            count === 1
              ? `Ton coach a annulé la séance "${first.titre}" prévue le ${formatTrainingDateTime(first.date_debut)}.`
              : `Ton coach a annulé les ${count} prochaines séances "${first.titre}", à partir du ${formatTrainingDateTime(first.date_debut)}.`,
        });
        await this.notifications.createMany(tx, rows);
      }

      return { cancelledCount: upcoming.length };
    });
  }

  // Propagation ticket §13 : UNE modification de contenu doit être visible
  // par tous les athlètes déjà assignés. updateMany sur training_session
  // reste O(1) requête quel que soit le nombre d'assignés (jamais une boucle
  // par athlète — voir rapport §24).
  //
  // notify (ticket "Notifications in-app...") : déjà décidé côté service
  // (comparaison avant/après des champs réellement modifiés, voir
  // CoachTrainingsService.updateContent) — null si aucun changement
  // significatif, pour ne jamais notifier un PATCH sans effet réel (ticket
  // "IDEMPOTENCE").
  async updateContentAndPropagate(
    trainingSessionId: string,
    fields: Partial<TrainingFieldsSnapshot>,
    notify: TrainingUpdateNotify | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.coach_training_session.update({ where: { id: trainingSessionId }, data: fields });

      const assignments = await tx.coach_training_assignment.findMany({
        where: { coach_training_session_id: trainingSessionId },
        select: { training_session_id: true, athlete_id: true },
      });

      if (assignments.length > 0) {
        await tx.training_session.updateMany({
          where: { id: { in: assignments.map((a) => a.training_session_id) } },
          data: fields,
        });
      }

      if (notify && assignments.length > 0) {
        const userIdByAthleteId = await this.resolveUserIds(
          tx,
          assignments.map((a) => a.athlete_id),
        );
        const location = notify.snapshot.lieu ? `, ${notify.snapshot.lieu}` : "";
        const rows = this.buildRows(assignments, userIdByAthleteId, {
          actorUserId: notify.actorUserId,
          type: TRAINING_UPDATED,
          title: "Entraînement modifié",
          message: `Ton coach a modifié la séance "${notify.snapshot.titre}" — nouvelle heure : ${formatTrainingDateTime(notify.snapshot.date_debut)}${location}.`,
        });
        await this.notifications.createMany(tx, rows);
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
  //
  // Idempotence (ticket "Notifications in-app...") : si la séance est DÉJÀ
  // annulée (rejeu du DELETE), aucune nouvelle notification n'est insérée —
  // comparé à statut AVANT écriture, dans la même transaction.
  async cancel(trainingSessionId: string, actorUserId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.coach_training_session.findUnique({
        where: { id: trainingSessionId },
        select: { titre: true, date_debut: true, lieu: true, statut: true },
      });

      await tx.coach_training_session.update({
        where: { id: trainingSessionId },
        data: { statut: CANCELLED_TRAINING_STATUS },
      });

      const assignments = await tx.coach_training_assignment.findMany({
        where: { coach_training_session_id: trainingSessionId },
        select: { training_session_id: true, athlete_id: true },
      });
      if (assignments.length > 0) {
        await tx.training_session.updateMany({
          where: { id: { in: assignments.map((a) => a.training_session_id) } },
          data: { statut: CANCELLED_TRAINING_STATUS },
        });
      }

      if (before && before.statut !== CANCELLED_TRAINING_STATUS && assignments.length > 0) {
        const userIdByAthleteId = await this.resolveUserIds(
          tx,
          assignments.map((a) => a.athlete_id),
        );
        const location = before.lieu ? `, ${before.lieu}` : "";
        const rows = this.buildRows(assignments, userIdByAthleteId, {
          actorUserId,
          type: TRAINING_CANCELLED,
          title: "Entraînement annulé",
          message: `Ton coach a annulé la séance "${before.titre}" prévue le ${formatTrainingDateTime(before.date_debut)}${location}.`,
        });
        await this.notifications.createMany(tx, rows);
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
  //
  // Ticket "Notifications in-app..." : seuls les NOUVEAUX athlètes (toAdd)
  // reçoivent TRAINING_ASSIGNED — un athlète déjà assigné avant cet appel
  // n'est jamais notifié juste parce que la liste de destinataires a changé
  // (voir ticket "CREATION TRAINING"/"MODIFICATION ASSIGNMENTS"). Un athlète
  // retiré (toRemove) ne reçoit rien : TRAINING_REMOVED n'existe pas en V1
  // (voir rapport final, décision explicite).
  async replaceAssignments(
    coachTrainingSessionId: string,
    fields: TrainingFieldsSnapshot,
    toAdd: { athleteId: string; groupId: string | null }[],
    toRemoveTrainingSessionIds: string[],
    newGroupIds: string[],
    actorUserId: string,
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

        await this.notifyAssigned(tx, actorUserId, fields, newRows);
      }

      await tx.coach_training_group_source.deleteMany({ where: { coach_training_session_id: coachTrainingSessionId } });
      if (newGroupIds.length > 0) {
        await tx.coach_training_group_source.createMany({
          data: newGroupIds.map((groupId) => ({ coach_training_session_id: coachTrainingSessionId, group_id: groupId })),
        });
      }
    });
  }

  // Factorisation TRAINING_ASSIGNED (ticket §22 "ne duplique jamais une
  // règle métier") : utilisée à la fois par createSessionWithAssignments et
  // replaceAssignments (toAdd), même message, même resource_id (le
  // training_session PROPRE à cet athlète, jamais coach_training_session_id
  // — voir modèle notification, resource_id sert au deep-link, l'athlète n'a
  // qu'une route parent /activite aujourd'hui mais l'id reste correct pour
  // un futur deep-link réel).
  private async notifyAssigned(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    fields: TrainingFieldsSnapshot,
    rows: { id: string; athlete_id: string }[],
  ): Promise<void> {
    const userIdByAthleteId = await this.resolveUserIds(
      tx,
      rows.map((r) => r.athlete_id),
    );
    const location = fields.lieu ? `, ${fields.lieu}` : "";
    const notificationRows = this.buildRows(
      rows.map((r) => ({ training_session_id: r.id, athlete_id: r.athlete_id })),
      userIdByAthleteId,
      {
        actorUserId,
        type: TRAINING_ASSIGNED,
        title: "Nouvel entraînement",
        message: `Ton coach t'a ajouté à une séance le ${formatTrainingDateTime(fields.date_debut)}${location}.`,
      },
    );
    await this.notifications.createMany(tx, notificationRows);
  }

  private async resolveUserIds(tx: Prisma.TransactionClient, athleteIds: string[]): Promise<Map<string, string>> {
    const rows = await this.notifications.resolveAthleteUserIds(tx, athleteIds);
    return new Map(rows.map((r) => [r.id, r.user_id]));
  }

  // resource_id = training_session_id PROPRE à chaque athlète (jamais un id
  // partagé) — un athlète sans app_user résolu est structurellement
  // impossible (voir NotificationsRepository.resolveAthleteUserIds) mais
  // filtré défensivement plutôt que de faire planter toute la publication
  // (ticket "CREATION TRAINING" : "ne pas crash toute la publication").
  private buildRows(
    assignments: { training_session_id: string; athlete_id: string }[],
    userIdByAthleteId: Map<string, string>,
    content: { actorUserId: string; type: string; title: string; message: string },
  ): NotificationInsertRow[] {
    return assignments.flatMap((a) => {
      const recipientUserId = userIdByAthleteId.get(a.athlete_id);
      if (!recipientUserId) {
        return [];
      }
      return [
        {
          recipient_user_id: recipientUserId,
          actor_user_id: content.actorUserId,
          context: "ATHLETE",
          type: content.type,
          title: content.title,
          message: content.message,
          resource_type: TRAINING_RESOURCE,
          resource_id: a.training_session_id,
        },
      ];
    });
  }
}
