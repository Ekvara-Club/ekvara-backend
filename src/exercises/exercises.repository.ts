import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma } from "../../generated/prisma/client";

export const EXERCISE_SELECT = {
  id: true,
  titre: true,
  type_exercice: true,
  panel_technique: true,
  niveau: true,
  description: true,
  video_url: true,
  gratuit: true,
} satisfies Prisma.exerciseSelect;

export type ExerciseView = Prisma.exerciseGetPayload<{ select: typeof EXERCISE_SELECT }>;

// Visibilité (voir ticket "Bibliothèque d'exercices Coach") : un exercice
// système/global (created_by_coach_id = null) est toujours visible ; un
// exercice coach ne l'est que pour les athlètes explicitement publiés (voir
// coach_exercise_assignment). Sans athleteId (ex. un coach-only qui
// appellerait ce catalogue partagé), seuls les exercices globaux sont
// renvoyés — jamais les exercices privés d'un coach quelconque.
function visibilityWhere(athleteId?: string): Prisma.exerciseWhereInput {
  if (!athleteId) {
    return { created_by_coach_id: null };
  }
  return {
    OR: [{ created_by_coach_id: null }, { coach_exercise_assignment: { some: { athlete_id: athleteId } } }],
  };
}

@Injectable()
export class ExercisesRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Une seule requête (OR global / assigné-à-cet-athlète), jamais une
  // requête par coach potentiellement concerné (ticket §24).
  findMany(athleteId?: string): Promise<ExerciseView[]> {
    return this.prisma.exercise.findMany({
      where: visibilityWhere(athleteId),
      select: EXERCISE_SELECT,
      orderBy: { titre: "asc" },
    });
  }

  // findFirst (pas findUnique) : le filtre de visibilité n'est pas une
  // simple égalité sur une clé unique, il doit se combiner avec `id`.
  findById(id: string, athleteId?: string): Promise<ExerciseView | null> {
    return this.prisma.exercise.findFirst({
      where: { id, ...visibilityWhere(athleteId) },
      select: EXERCISE_SELECT,
    });
  }
}
