import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma } from "../../generated/prisma/client";

export const GOAL_STEP_SELECT = {
  id: true,
  titre: true,
  ordre: true,
  completed: true,
  completed_at: true,
} satisfies Prisma.goal_stepSelect;

export const GOAL_SELECT = {
  id: true,
  type: true,
  titre: true,
  description: true,
  date_cible: true,
  statut: true,
  goal_step: {
    select: GOAL_STEP_SELECT,
    orderBy: { ordre: "asc" },
  },
} satisfies Prisma.athlete_goalSelect;

export type GoalWithSteps = Prisma.athlete_goalGetPayload<{ select: typeof GOAL_SELECT }>;
export type GoalStep = Prisma.goal_stepGetPayload<{ select: typeof GOAL_STEP_SELECT }>;

@Injectable()
export class GoalsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async athleteExists(athleteId: string): Promise<boolean> {
    const athlete = await this.prisma.athlete.findUnique({
      where: { id: athleteId },
      select: { id: true },
    });
    return athlete !== null;
  }

  createGoal(
    athleteId: string,
    data: { type?: string; titre: string; description?: string; dateCible?: Date },
  ): Promise<GoalWithSteps> {
    return this.prisma.athlete_goal.create({
      data: {
        athlete_id: athleteId,
        type: data.type,
        titre: data.titre,
        description: data.description,
        date_cible: data.dateCible,
      },
      select: GOAL_SELECT,
    });
  }

  findAllByAthlete(athleteId: string): Promise<GoalWithSteps[]> {
    return this.prisma.athlete_goal.findMany({
      where: { athlete_id: athleteId },
      select: GOAL_SELECT,
      orderBy: [{ date_cible: { sort: "asc", nulls: "last" } }, { created_at: "asc" }],
    });
  }

  // Sélection de l'objectif actif : statut "en_cours", date_cible la plus proche
  // en premier, et les objectifs sans date_cible passent après ceux qui en ont une
  // (nulls: "last"). Voir GoalsService pour la doc complète de la règle.
  findActiveByAthlete(athleteId: string): Promise<GoalWithSteps | null> {
    return this.prisma.athlete_goal.findFirst({
      where: { athlete_id: athleteId, statut: "en_cours" },
      select: GOAL_SELECT,
      orderBy: [{ date_cible: { sort: "asc", nulls: "last" } }, { created_at: "asc" }],
    });
  }

  async goalBelongsToAthlete(goalId: string, athleteId: string): Promise<boolean> {
    const goal = await this.prisma.athlete_goal.findFirst({
      where: { id: goalId, athlete_id: athleteId },
      select: { id: true },
    });
    return goal !== null;
  }

  createStep(goalId: string, data: { titre: string; ordre?: number }): Promise<GoalStep> {
    return this.prisma.goal_step.create({
      data: {
        goal_id: goalId,
        titre: data.titre,
        ordre: data.ordre,
      },
      select: GOAL_STEP_SELECT,
    });
  }

  async stepBelongsToGoal(stepId: string, goalId: string): Promise<boolean> {
    const step = await this.prisma.goal_step.findFirst({
      where: { id: stepId, goal_id: goalId },
      select: { id: true },
    });
    return step !== null;
  }

  updateStepCompleted(stepId: string, completed: boolean, completedAt: Date | null): Promise<GoalStep> {
    return this.prisma.goal_step.update({
      where: { id: stepId },
      data: { completed, completed_at: completedAt },
      select: GOAL_STEP_SELECT,
    });
  }

  // Ne touche qu'au statut : titre/description/date_cible/steps restent
  // strictement inchangés.
  updateStatus(goalId: string, statut: string): Promise<GoalWithSteps> {
    return this.prisma.athlete_goal.update({
      where: { id: goalId },
      data: { statut },
      select: GOAL_SELECT,
    });
  }
}
