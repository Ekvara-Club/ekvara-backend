import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  CoachTrainingDetail,
  CoachTrainingSummary,
  CoachTrainingsRepository,
  TrainingFieldsSnapshot,
  TrainingUpdateNotify,
} from "./coach-trainings.repository";
import { CoachDestinataireResolver, ResolvedDestinataires } from "./coach-destinataire-resolver";
import { CreateCoachTrainingDto } from "./dto/create-coach-training.dto";
import { UpdateCoachTrainingDto } from "./dto/update-coach-training.dto";
import { ReplaceCoachTrainingAssignmentsDto } from "./dto/replace-coach-training-assignments.dto";
import { CreateCoachTrainingSeriesDto } from "./dto/create-coach-training-series.dto";
import { buildSeriesOccurrences, formatWeekdaysFr } from "./training-series.util";
import { formatTrainingDate } from "../notifications/notifications.util";

@Injectable()
export class CoachTrainingsService {
  constructor(
    private readonly repository: CoachTrainingsRepository,
    private readonly destinataireResolver: CoachDestinataireResolver,
  ) {}

  async createTraining(coachId: string, actorUserId: string, dto: CreateCoachTrainingDto) {
    const fields = toFieldsSnapshot(dto);
    assertEndAfterStart(fields.date_debut, fields.date_fin);

    const resolved = await this.destinataireResolver.resolve(coachId, dto.groupIds ?? [], dto.athleteIds ?? []);
    const athletes = toAthletesWithGroupLabel(resolved);

    const sessionId = await this.repository.createSessionWithAssignments(
      coachId,
      fields,
      athletes,
      resolved.groupIds,
      actorUserId,
    );
    return this.findOneForCoach(sessionId);
  }

  // Séance récurrente : chaque occurrence devient une séance collective
  // ordinaire (voir CoachTrainingsRepository.createSeriesWithAssignments),
  // reliée aux autres par un series_id commun. Destinataires résolus UNE
  // fois et figés pour toute la série (même règle de snapshot qu'une séance
  // isolée : un athlète qui rejoint le groupe plus tard ne reçoit rien).
  async createSeries(coachId: string, actorUserId: string, dto: CreateCoachTrainingSeriesDto) {
    if (dto.endTime !== undefined && dto.endTime <= dto.startTime) {
      throw new BadRequestException("endTime doit être strictement postérieure à startTime");
    }

    const occurrences = buildSeriesOccurrences({
      startDate: dto.startDate,
      startTime: dto.startTime,
      endTime: dto.endTime,
      weekdays: dto.weekdays,
      durationMonths: dto.durationMonths,
    });
    // Toujours au moins une occurrence avec un jour coché sur ≥ 1 mois ;
    // défensif si les règles de validation changent un jour.
    if (occurrences.length === 0) {
      throw new BadRequestException("Aucune séance ne tombe dans la période choisie");
    }

    const resolved = await this.destinataireResolver.resolve(coachId, dto.groupIds ?? [], dto.athleteIds ?? []);
    const athletes = toAthletesWithGroupLabel(resolved);

    const content = {
      titre: dto.title,
      type_seance: dto.type,
      sous_type: dto.subType,
      lieu: dto.location,
      niveau: dto.level,
      description: dto.description,
    };
    const fieldsList: TrainingFieldsSnapshot[] = occurrences.map((o) => ({
      ...content,
      date_debut: o.startAt,
      date_fin: o.endAt,
    }));

    const first = occurrences[0].startAt;
    const last = occurrences[occurrences.length - 1].startAt;
    const location = dto.location ? `, ${dto.location}` : "";
    const seriesId = randomUUID();

    await this.repository.createSeriesWithAssignments(coachId, seriesId, fieldsList, athletes, resolved.groupIds, {
      actorUserId,
      title: "Nouvel entraînement récurrent",
      message:
        `Ton coach t'a ajouté à la séance "${dto.title}" chaque ${formatWeekdaysFr(dto.weekdays)} à ` +
        `${dto.startTime.replace(":", "h")}${location} : ${occurrences.length} séances, ` +
        `du ${formatTrainingDate(first)} au ${formatTrainingDate(last)}.`,
    });

    return {
      seriesId,
      occurrenceCount: occurrences.length,
      firstStartAt: first,
      lastStartAt: last,
      athleteCount: athletes.length,
    };
  }

  // Série inconnue ou appartenant à un autre coach -> 403 (jamais 404), même
  // politique que CoachTrainingOwnershipGuard : ne jamais confirmer
  // l'existence d'une série à un coach qui n'en est pas propriétaire.
  async cancelUpcomingInSeries(coachId: string, actorUserId: string, seriesId: string, now: Date = new Date()) {
    const owner = await this.repository.findSeriesOwnership(seriesId);
    if (!owner || owner.coach_id !== coachId) {
      throw new ForbiddenException("Accès interdit à cette série");
    }
    return this.repository.cancelUpcomingInSeries(seriesId, now, actorUserId);
  }

  async findAllForCoach(coachId: string, range?: { from: Date; to: Date }) {
    const sessions = await this.repository.findSessionsForCoach(coachId, range);
    return sessions.map(toSummaryView);
  }

  async findOneForCoach(trainingSessionId: string) {
    const detail = await this.repository.findSessionDetail(trainingSessionId);
    if (!detail) {
      // Défensif : CoachTrainingOwnershipGuard a déjà résolu cette séance
      // avant d'atteindre le service (sauf appel interne juste après
      // création, où l'id vient d'être créé par ce même service).
      throw new NotFoundException(`Séance ${trainingSessionId} introuvable`);
    }
    return toDetailView(detail);
  }

  async updateContent(trainingSessionId: string, actorUserId: string, dto: UpdateCoachTrainingDto) {
    assertAtLeastOneField(dto);

    const current = await this.repository.findSessionDetail(trainingSessionId);
    if (!current) {
      throw new NotFoundException(`Séance ${trainingSessionId} introuvable`);
    }

    const merged = mergeFields(current, dto);
    assertEndAfterStart(merged.date_debut, merged.date_fin);

    const patch = toPartialFieldsSnapshot(dto);

    // Ticket "Notifications in-app..." §IDEMPOTENCE : compare le patch aux
    // valeurs ACTUELLES (jamais le simple fait qu'un PATCH ait été appelé)
    // — un champ renvoyé avec sa valeur déjà en place ne déclenche aucune
    // notification. Tous les champs de TrainingFieldsSnapshot sont du
    // contenu réellement exposé à l'athlète sur training_session (titre,
    // type, sous-type, dates, lieu, niveau, description) : n'importe lequel
    // d'entre eux change = changement significatif (ticket "TRAINING
    // UPDATE").
    const currentSnapshot = toFieldsSnapshot(current);
    const notify: TrainingUpdateNotify | null = hasSignificantChange(currentSnapshot, patch)
      ? { actorUserId, snapshot: { ...currentSnapshot, ...patch } }
      : null;

    await this.repository.updateContentAndPropagate(trainingSessionId, patch, notify);
    return this.findOneForCoach(trainingSessionId);
  }

  async replaceAssignments(
    coachId: string,
    actorUserId: string,
    trainingSessionId: string,
    dto: ReplaceCoachTrainingAssignmentsDto,
  ) {
    const current = await this.repository.findSessionDetail(trainingSessionId);
    if (!current) {
      throw new NotFoundException(`Séance ${trainingSessionId} introuvable`);
    }

    const resolved = await this.destinataireResolver.resolve(coachId, dto.groupIds, dto.athleteIds);
    const newAthleteIdSet = new Set(resolved.athleteIds);

    const currentAssignments = await this.repository.findCurrentAssignments(trainingSessionId);
    const currentAthleteIds = new Set(currentAssignments.map((a) => a.athlete_id));

    const toAddAthleteIds = resolved.athleteIds.filter((id) => !currentAthleteIds.has(id));
    const toAdd = toAthletesWithGroupLabel(resolved).filter((a) => toAddAthleteIds.includes(a.athleteId));
    const toRemove = currentAssignments.filter((a) => !newAthleteIdSet.has(a.athlete_id));

    // Ticket "Présences Coach V1" §3/§15 : refuser tout le remplacement
    // (pas d'application partielle) si retirer un athlète détruirait une
    // présence déjà enregistrée pour cette séance — jamais un effacement
    // silencieux d'historique.
    if (toRemove.length > 0) {
      const attendanceOnRemoved = await this.repository.findAttendanceForTrainingSessions(
        toRemove.map((a) => a.training_session_id),
      );
      if (attendanceOnRemoved.length > 0) {
        throw new ConflictException(
          "Impossible de retirer un ou plusieurs athlètes : une présence est déjà enregistrée pour cette séance.",
        );
      }
    }

    await this.repository.replaceAssignments(
      trainingSessionId,
      toFieldsSnapshot(current),
      toAdd,
      toRemove.map((a) => a.training_session_id),
      resolved.groupIds,
      actorUserId,
    );

    return this.findOneForCoach(trainingSessionId);
  }

  async cancel(trainingSessionId: string, actorUserId: string) {
    await this.repository.cancel(trainingSessionId, actorUserId);
    return this.findOneForCoach(trainingSessionId);
  }
}

// Ticket "Notifications in-app..." §IDEMPOTENCE : compare uniquement les
// clés PRÉSENTES dans `patch` (un PATCH partiel ne touche jamais les champs
// absents) contre leur valeur actuelle correspondante dans `current`. Dates
// comparées par timestamp (jamais par référence d'objet Date).
function hasSignificantChange(
  current: TrainingFieldsSnapshot,
  patch: Partial<TrainingFieldsSnapshot>,
): boolean {
  return (Object.keys(patch) as (keyof TrainingFieldsSnapshot)[]).some((key) => {
    const before = current[key];
    const after = patch[key];
    if (before instanceof Date || after instanceof Date) {
      const beforeTime = before instanceof Date ? before.getTime() : null;
      const afterTime = after instanceof Date ? after.getTime() : null;
      return beforeTime !== afterTime;
    }
    return (before ?? null) !== (after ?? null);
  });
}

function toFieldsSnapshot(source: {
  titre?: string;
  title?: string;
  type_seance?: string | null;
  type?: string;
  sous_type?: string | null;
  subType?: string;
  date_debut?: Date;
  startAt?: string;
  date_fin?: Date | null;
  endAt?: string;
  lieu?: string | null;
  location?: string;
  niveau?: string | null;
  level?: string;
  description?: string | null;
}): TrainingFieldsSnapshot {
  // Accepte indifféremment la forme DTO (camelCase) ou la forme déjà
  // résolue (CoachTrainingDetail, snake_case) : évite deux fonctions de
  // mapping quasi identiques pour createTraining et replaceAssignments.
  const titre = source.title ?? source.titre;
  const dateDebut = source.startAt ? new Date(source.startAt) : source.date_debut;
  if (!titre || !dateDebut) {
    throw new BadRequestException("title et startAt sont requis");
  }

  const dateFin = source.endAt !== undefined ? new Date(source.endAt) : (source.date_fin ?? undefined);

  return {
    titre,
    type_seance: source.type ?? source.type_seance ?? undefined,
    sous_type: source.subType ?? source.sous_type ?? undefined,
    date_debut: dateDebut,
    date_fin: dateFin ?? undefined,
    lieu: source.location ?? source.lieu ?? undefined,
    niveau: source.level ?? source.niveau ?? undefined,
    description: source.description ?? undefined,
  };
}

function toPartialFieldsSnapshot(dto: UpdateCoachTrainingDto): Partial<TrainingFieldsSnapshot> {
  const patch: Partial<TrainingFieldsSnapshot> = {};
  if (dto.title !== undefined) patch.titre = dto.title;
  if (dto.type !== undefined) patch.type_seance = dto.type;
  if (dto.subType !== undefined) patch.sous_type = dto.subType;
  if (dto.startAt !== undefined) patch.date_debut = new Date(dto.startAt);
  if (dto.endAt !== undefined) patch.date_fin = new Date(dto.endAt);
  if (dto.location !== undefined) patch.lieu = dto.location;
  if (dto.level !== undefined) patch.niveau = dto.level;
  if (dto.description !== undefined) patch.description = dto.description;
  return patch;
}

function mergeFields(
  current: Pick<CoachTrainingDetail, "titre" | "date_debut" | "date_fin">,
  dto: UpdateCoachTrainingDto,
): { date_debut: Date; date_fin?: Date } {
  return {
    date_debut: dto.startAt !== undefined ? new Date(dto.startAt) : current.date_debut,
    date_fin: dto.endAt !== undefined ? new Date(dto.endAt) : (current.date_fin ?? undefined),
  };
}

function assertAtLeastOneField(dto: UpdateCoachTrainingDto): void {
  const hasAnyField = Object.values(dto).some((value) => value !== undefined);
  if (!hasAnyField) {
    throw new BadRequestException("Au moins un champ doit être fourni");
  }
}

// Même règle que TrainingsService.createTraining (athlete-facing), jamais
// redivergée : end > start si end existe.
function assertEndAfterStart(startAt: Date, endAt?: Date): void {
  if (endAt && endAt <= startAt) {
    throw new BadRequestException("date_fin doit être strictement postérieure à date_debut");
  }
}

// Ticket "Présences Coach V1" §6/§19 : associe à chaque athlète résolu le
// groupe l'ayant réellement produit (premier trouvé si plusieurs — c'est un
// libellé d'affichage, pas une autorisation), null si assignation
// individuelle. Construit à partir des lignes de membership brutes déjà
// récupérées par CoachDestinataireResolver (pas de requête supplémentaire).
function toAthletesWithGroupLabel(resolved: ResolvedDestinataires): { athleteId: string; groupId: string | null }[] {
  const groupByAthlete = new Map<string, string>();
  for (const member of resolved.groupMembers) {
    if (!groupByAthlete.has(member.athlete_id)) {
      groupByAthlete.set(member.athlete_id, member.group_id);
    }
  }
  return resolved.athleteIds.map((athleteId) => ({
    athleteId,
    groupId: groupByAthlete.get(athleteId) ?? null,
  }));
}

function toSummaryView(session: CoachTrainingSummary) {
  return {
    id: session.id,
    title: session.titre,
    type: session.type_seance,
    subType: session.sous_type,
    startAt: session.date_debut,
    endAt: session.date_fin,
    location: session.lieu,
    level: session.niveau,
    description: session.description,
    status: session.statut,
    seriesId: session.series_id,
    athleteCount: session._count.assignments,
  };
}

function toDetailView(session: CoachTrainingDetail) {
  const athletes = session.assignments.map((a) => ({
    id: a.athlete.id,
    firstName: a.athlete.app_user.prenom,
    lastName: a.athlete.app_user.nom,
  }));
  const groups = session.group_sources.map((s) => ({ id: s.coach_group.id, name: s.coach_group.name }));

  return {
    id: session.id,
    title: session.titre,
    type: session.type_seance,
    subType: session.sous_type,
    startAt: session.date_debut,
    endAt: session.date_fin,
    location: session.lieu,
    level: session.niveau,
    description: session.description,
    status: session.statut,
    seriesId: session.series_id,
    assignments: {
      athleteCount: athletes.length,
      athletes,
      groups,
    },
  };
}
