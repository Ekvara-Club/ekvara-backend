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

@Injectable()
export class ExercisesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findMany(): Promise<ExerciseView[]> {
    return this.prisma.exercise.findMany({
      select: EXERCISE_SELECT,
      orderBy: { titre: "asc" },
    });
  }

  findById(id: string): Promise<ExerciseView | null> {
    return this.prisma.exercise.findUnique({
      where: { id },
      select: EXERCISE_SELECT,
    });
  }
}
