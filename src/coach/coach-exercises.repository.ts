import { Injectable } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const SAFE_USER_SELECT = { id: true, email: true, nom: true, prenom: true } as const;

export interface ExerciseFieldsSnapshot {
  titre: string;
  type_exercice?: string;
  panel_technique?: string;
  niveau?: string;
  description?: string;
  video_url?: string;
}

const LIBRARY_SELECT = {
  id: true,
  titre: true,
  type_exercice: true,
  panel_technique: true,
  niveau: true,
  description: true,
  video_url: true,
  _count: { select: { coach_exercise_assignment: true } },
  coach_exercise_group_source: { select: { coach_group: { select: { id: true, name: true } } } },
} satisfies Prisma.exerciseSelect;

const DETAIL_SELECT = {
  id: true,
  titre: true,
  type_exercice: true,
  panel_technique: true,
  niveau: true,
  description: true,
  video_url: true,
  coach_exercise_assignment: {
    select: { athlete: { select: { id: true, app_user: { select: SAFE_USER_SELECT } } } },
  },
  coach_exercise_group_source: { select: { coach_group: { select: { id: true, name: true } } } },
} satisfies Prisma.exerciseSelect;

export type CoachExerciseLibraryRow = Prisma.exerciseGetPayload<{ select: typeof LIBRARY_SELECT }>;
export type CoachExerciseDetail = Prisma.exerciseGetPayload<{ select: typeof DETAIL_SELECT }>;

@Injectable()
export class CoachExercisesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(coachId: string, fields: ExerciseFieldsSnapshot): Promise<string> {
    const created = await this.prisma.exercise.create({
      data: { created_by_coach_id: coachId, ...fields },
      select: { id: true },
    });
    return created.id;
  }

  findLibraryForCoach(coachId: string): Promise<CoachExerciseLibraryRow[]> {
    return this.prisma.exercise.findMany({
      where: { created_by_coach_id: coachId },
      select: LIBRARY_SELECT,
      orderBy: { titre: "asc" },
    });
  }

  findDetail(exerciseId: string): Promise<CoachExerciseDetail | null> {
    return this.prisma.exercise.findUnique({
      where: { id: exerciseId },
      select: DETAIL_SELECT,
    });
  }

  update(exerciseId: string, fields: Partial<ExerciseFieldsSnapshot>): Promise<void> {
    // Une seule ligne partagée (contrairement à training_session) : nul
    // besoin de propagation batch, la modification est instantanément
    // visible pour tous les athlètes ayant déjà accès (ticket §10).
    return this.prisma.exercise.update({ where: { id: exerciseId }, data: fields }).then(() => undefined);
  }

  // Suppression physique (voir rapport §13 pour la justification : aucun
  // système d'archivage n'existe, aucune autre table ne référence
  // exercise.id en dehors de coach_exercise_assignment/group_source qui
  // cascadent — contrairement à training_session, il n'y a ici aucun
  // historique daté d'athlète à préserver).
  delete(exerciseId: string): Promise<void> {
    return this.prisma.exercise.delete({ where: { id: exerciseId } }).then(() => undefined);
  }

  findCurrentAssignments(exerciseId: string) {
    return this.prisma.coach_exercise_assignment.findMany({
      where: { exercise_id: exerciseId },
      select: { athlete_id: true },
    });
  }

  // Remplacement complet transactionnel (ticket §14), même principe que
  // CoachTrainingsRepository.replaceAssignments mais sans generation de
  // lignes dupliquées : ajoute/retire des lignes coach_exercise_assignment
  // pointant directement sur l'unique exercise, remplace intégralement les
  // group_sources.
  async replaceAssignments(
    exerciseId: string,
    toAddAthleteIds: string[],
    toRemoveAthleteIds: string[],
    newGroupIds: string[],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (toRemoveAthleteIds.length > 0) {
        await tx.coach_exercise_assignment.deleteMany({
          where: { exercise_id: exerciseId, athlete_id: { in: toRemoveAthleteIds } },
        });
      }

      if (toAddAthleteIds.length > 0) {
        // skipDuplicates : défense en profondeur (ticket §22 "concurrence")
        // au cas où toAddAthleteIds contiendrait un athlète déjà assigné —
        // le diff normal (CoachExercisesService) ne devrait jamais produire
        // ce cas, mais deux PUT concurrents sur le même exercice pourraient
        // calculer un diff légèrement périmé l'un par rapport à l'autre.
        await tx.coach_exercise_assignment.createMany({
          data: toAddAthleteIds.map((athleteId) => ({ exercise_id: exerciseId, athlete_id: athleteId })),
          skipDuplicates: true,
        });
      }

      await tx.coach_exercise_group_source.deleteMany({ where: { exercise_id: exerciseId } });
      if (newGroupIds.length > 0) {
        await tx.coach_exercise_group_source.createMany({
          data: newGroupIds.map((groupId) => ({ exercise_id: exerciseId, group_id: groupId })),
          skipDuplicates: true,
        });
      }
    });
  }
}
