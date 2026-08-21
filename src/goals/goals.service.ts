import { Injectable, NotFoundException } from "@nestjs/common";
import { CreateGoalDto } from "./dto/create-goal.dto";
import { CreateGoalStepDto } from "./dto/create-goal-step.dto";
import { UpdateGoalStepDto } from "./dto/update-goal-step.dto";
import { UpdateGoalStatusDto } from "./dto/update-goal-status.dto";
import { GoalsRepository, GoalStep, GoalWithSteps } from "./goals.repository";

@Injectable()
export class GoalsService {
  constructor(private readonly goalsRepository: GoalsRepository) {}

  async createGoal(athleteId: string, dto: CreateGoalDto) {
    await this.assertAthleteExists(athleteId);

    const created = await this.goalsRepository.createGoal(athleteId, {
      type: dto.type,
      titre: dto.titre,
      description: dto.description,
      dateCible: dto.dateCible ? new Date(dto.dateCible) : undefined,
    });

    return toGoalView(created);
  }

  async addStep(athleteId: string, goalId: string, dto: CreateGoalStepDto) {
    await this.assertAthleteExists(athleteId);
    await this.assertGoalBelongsToAthlete(goalId, athleteId);

    const created = await this.goalsRepository.createStep(goalId, {
      titre: dto.titre,
      ordre: dto.ordre,
    });

    return toStepView(created);
  }

  async updateStep(athleteId: string, goalId: string, stepId: string, dto: UpdateGoalStepDto) {
    await this.assertAthleteExists(athleteId);
    await this.assertGoalBelongsToAthlete(goalId, athleteId);

    const stepExists = await this.goalsRepository.stepBelongsToGoal(stepId, goalId);
    if (!stepExists) {
      throw new NotFoundException(`Étape ${stepId} introuvable pour l'objectif ${goalId}`);
    }

    const completedAt = dto.completed ? new Date() : null;
    const updated = await this.goalsRepository.updateStepCompleted(stepId, dto.completed, completedAt);
    return toStepView(updated);
  }

  async updateStatus(athleteId: string, goalId: string, dto: UpdateGoalStatusDto) {
    await this.assertAthleteExists(athleteId);
    await this.assertGoalBelongsToAthlete(goalId, athleteId);

    const updated = await this.goalsRepository.updateStatus(goalId, dto.statut);
    return toGoalView(updated);
  }

  async findAllForAthlete(athleteId: string) {
    await this.assertAthleteExists(athleteId);

    const goals = await this.goalsRepository.findAllByAthlete(athleteId);
    // "en_cours" d'abord, en conservant l'ordre par date_cible croissante (nulls en
    // dernier) déjà appliqué par le repository dans chaque groupe (tri stable).
    const sorted = [...goals].sort(
      (a, b) => enCoursRank(a.statut) - enCoursRank(b.statut),
    );
    return sorted.map(toGoalView);
  }

  async findActiveForAthlete(athleteId: string) {
    await this.assertAthleteExists(athleteId);

    const active = await this.goalsRepository.findActiveByAthlete(athleteId);
    return active ? toGoalView(active) : null;
  }

  private async assertAthleteExists(athleteId: string): Promise<void> {
    const exists = await this.goalsRepository.athleteExists(athleteId);
    if (!exists) {
      throw new NotFoundException(`Athlete ${athleteId} introuvable`);
    }
  }

  private async assertGoalBelongsToAthlete(goalId: string, athleteId: string): Promise<void> {
    const belongs = await this.goalsRepository.goalBelongsToAthlete(goalId, athleteId);
    if (!belongs) {
      throw new NotFoundException(`Objectif ${goalId} introuvable pour cet athlète`);
    }
  }
}

function enCoursRank(statut: string | null): number {
  return statut === "en_cours" ? 0 : 1;
}

function toStepView(step: GoalStep) {
  return {
    id: step.id,
    titre: step.titre,
    ordre: step.ordre,
    completed: step.completed,
  };
}

function toGoalView(goal: GoalWithSteps) {
  const steps = goal.goal_step;
  const total = steps.length;
  const completed = steps.filter((step) => step.completed).length;
  const percentage = total === 0 ? null : Math.round((completed / total) * 100);

  return {
    id: goal.id,
    type: goal.type,
    titre: goal.titre,
    description: goal.description,
    dateCible: goal.date_cible,
    statut: goal.statut,
    progress: { completed, total, percentage },
    steps: steps.map(toStepView),
  };
}
