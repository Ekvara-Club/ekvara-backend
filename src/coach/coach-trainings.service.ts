import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  CoachTrainingDetail,
  CoachTrainingSummary,
  CoachTrainingsRepository,
  TrainingFieldsSnapshot,
} from "./coach-trainings.repository";
import { CoachDestinataireResolver } from "./coach-destinataire-resolver";
import { CreateCoachTrainingDto } from "./dto/create-coach-training.dto";
import { UpdateCoachTrainingDto } from "./dto/update-coach-training.dto";
import { ReplaceCoachTrainingAssignmentsDto } from "./dto/replace-coach-training-assignments.dto";

@Injectable()
export class CoachTrainingsService {
  constructor(
    private readonly repository: CoachTrainingsRepository,
    private readonly destinataireResolver: CoachDestinataireResolver,
  ) {}

  async createTraining(coachId: string, dto: CreateCoachTrainingDto) {
    const fields = toFieldsSnapshot(dto);
    assertEndAfterStart(fields.date_debut, fields.date_fin);

    const { athleteIds, groupIds } = await this.destinataireResolver.resolve(
      coachId,
      dto.groupIds ?? [],
      dto.athleteIds ?? [],
    );

    const sessionId = await this.repository.createSessionWithAssignments(coachId, fields, athleteIds, groupIds);
    return this.findOneForCoach(sessionId);
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

  async updateContent(trainingSessionId: string, dto: UpdateCoachTrainingDto) {
    assertAtLeastOneField(dto);

    const current = await this.repository.findSessionDetail(trainingSessionId);
    if (!current) {
      throw new NotFoundException(`Séance ${trainingSessionId} introuvable`);
    }

    const merged = mergeFields(current, dto);
    assertEndAfterStart(merged.date_debut, merged.date_fin);

    const patch = toPartialFieldsSnapshot(dto);
    await this.repository.updateContentAndPropagate(trainingSessionId, patch);
    return this.findOneForCoach(trainingSessionId);
  }

  async replaceAssignments(coachId: string, trainingSessionId: string, dto: ReplaceCoachTrainingAssignmentsDto) {
    const current = await this.repository.findSessionDetail(trainingSessionId);
    if (!current) {
      throw new NotFoundException(`Séance ${trainingSessionId} introuvable`);
    }

    const { athleteIds: newAthleteIds, groupIds: validGroupIds } = await this.destinataireResolver.resolve(
      coachId,
      dto.groupIds,
      dto.athleteIds,
    );

    const currentAssignments = await this.repository.findCurrentAssignments(trainingSessionId);
    const currentAthleteIds = new Set(currentAssignments.map((a) => a.athlete_id));
    const newAthleteIdSet = new Set(newAthleteIds);

    const toAdd = newAthleteIds.filter((id) => !currentAthleteIds.has(id));
    const toRemove = currentAssignments.filter((a) => !newAthleteIdSet.has(a.athlete_id));

    await this.repository.replaceAssignments(
      trainingSessionId,
      toFieldsSnapshot(current),
      toAdd,
      toRemove.map((a) => a.training_session_id),
      validGroupIds,
    );

    return this.findOneForCoach(trainingSessionId);
  }

  async cancel(trainingSessionId: string) {
    await this.repository.cancel(trainingSessionId);
    return this.findOneForCoach(trainingSessionId);
  }
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
    assignments: {
      athleteCount: athletes.length,
      athletes,
      groups,
    },
  };
}
