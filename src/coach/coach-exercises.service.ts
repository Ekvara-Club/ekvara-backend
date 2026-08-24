import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  CoachExerciseDetail,
  CoachExerciseLibraryRow,
  CoachExercisesRepository,
  ExerciseFieldsSnapshot,
} from "./coach-exercises.repository";
import { CoachDestinataireResolver } from "./coach-destinataire-resolver";
import { CreateCoachExerciseDto } from "./dto/create-coach-exercise.dto";
import { UpdateCoachExerciseDto } from "./dto/update-coach-exercise.dto";
import { ReplaceCoachExerciseAssignmentsDto } from "./dto/replace-coach-exercise-assignments.dto";

@Injectable()
export class CoachExercisesService {
  constructor(
    private readonly repository: CoachExercisesRepository,
    private readonly destinataireResolver: CoachDestinataireResolver,
  ) {}

  async createExercise(coachId: string, dto: CreateCoachExerciseDto) {
    const exerciseId = await this.repository.create(coachId, toFieldsSnapshot(dto));
    return this.findOneForCoach(exerciseId);
  }

  async findLibraryForCoach(coachId: string) {
    const rows = await this.repository.findLibraryForCoach(coachId);
    return rows.map(toLibraryView);
  }

  async findOneForCoach(exerciseId: string) {
    const detail = await this.repository.findDetail(exerciseId);
    if (!detail) {
      // Défensif : CoachExerciseOwnershipGuard a déjà résolu cet exercice
      // avant d'atteindre le service (sauf appel interne juste après
      // création, où l'id vient d'être créé par ce même service).
      throw new NotFoundException(`Exercice ${exerciseId} introuvable`);
    }
    return toDetailView(detail);
  }

  async updateContent(exerciseId: string, dto: UpdateCoachExerciseDto) {
    assertAtLeastOneField(dto);
    await this.repository.update(exerciseId, toPartialFieldsSnapshot(dto));
    return this.findOneForCoach(exerciseId);
  }

  async deleteExercise(exerciseId: string): Promise<void> {
    await this.repository.delete(exerciseId);
  }

  async replaceAssignments(coachId: string, exerciseId: string, dto: ReplaceCoachExerciseAssignmentsDto) {
    const { athleteIds: newAthleteIds, groupIds: validGroupIds } = await this.destinataireResolver.resolve(
      coachId,
      dto.groupIds,
      dto.athleteIds,
    );

    const currentAssignments = await this.repository.findCurrentAssignments(exerciseId);
    const currentAthleteIds = new Set(currentAssignments.map((a) => a.athlete_id));
    const newAthleteIdSet = new Set(newAthleteIds);

    const toAdd = newAthleteIds.filter((id) => !currentAthleteIds.has(id));
    const toRemove = [...currentAthleteIds].filter((id) => !newAthleteIdSet.has(id));

    await this.repository.replaceAssignments(exerciseId, toAdd, toRemove, validGroupIds);
    return this.findOneForCoach(exerciseId);
  }
}

function toFieldsSnapshot(dto: CreateCoachExerciseDto): ExerciseFieldsSnapshot {
  return {
    titre: dto.title,
    type_exercice: dto.type,
    panel_technique: dto.panelTechnique,
    niveau: dto.level,
    description: dto.description,
    video_url: dto.videoUrl,
  };
}

function toPartialFieldsSnapshot(dto: UpdateCoachExerciseDto): Partial<ExerciseFieldsSnapshot> {
  const patch: Partial<ExerciseFieldsSnapshot> = {};
  if (dto.title !== undefined) patch.titre = dto.title;
  if (dto.type !== undefined) patch.type_exercice = dto.type;
  if (dto.panelTechnique !== undefined) patch.panel_technique = dto.panelTechnique;
  if (dto.level !== undefined) patch.niveau = dto.level;
  if (dto.description !== undefined) patch.description = dto.description;
  if (dto.videoUrl !== undefined) patch.video_url = dto.videoUrl;
  return patch;
}

function assertAtLeastOneField(dto: UpdateCoachExerciseDto): void {
  const hasAnyField = Object.values(dto).some((value) => value !== undefined);
  if (!hasAnyField) {
    throw new BadRequestException("Au moins un champ doit être fourni");
  }
}

function toLibraryView(row: CoachExerciseLibraryRow) {
  return {
    id: row.id,
    title: row.titre,
    type: row.type_exercice,
    panelTechnique: row.panel_technique,
    level: row.niveau,
    description: row.description,
    videoUrl: row.video_url,
    athleteCount: row._count.coach_exercise_assignment,
    groups: row.coach_exercise_group_source.map((s) => ({ id: s.coach_group.id, name: s.coach_group.name })),
  };
}

function toDetailView(detail: CoachExerciseDetail) {
  const athletes = detail.coach_exercise_assignment.map((a) => ({
    id: a.athlete.id,
    firstName: a.athlete.app_user.prenom,
    lastName: a.athlete.app_user.nom,
  }));
  const groups = detail.coach_exercise_group_source.map((s) => ({ id: s.coach_group.id, name: s.coach_group.name }));

  return {
    id: detail.id,
    title: detail.titre,
    type: detail.type_exercice,
    panelTechnique: detail.panel_technique,
    level: detail.niveau,
    description: detail.description,
    videoUrl: detail.video_url,
    assignments: {
      athleteCount: athletes.length,
      athletes,
      groups,
    },
  };
}
