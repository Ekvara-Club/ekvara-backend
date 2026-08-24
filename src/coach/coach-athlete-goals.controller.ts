import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { GoalsService } from "../goals/goals.service";
import { CreateGoalDto } from "../goals/dto/create-goal.dto";
import { CreateGoalStepDto } from "../goals/dto/create-goal-step.dto";
import { UpdateGoalStepDto } from "../goals/dto/update-goal-step.dto";
import { UpdateGoalStatusDto } from "../goals/dto/update-goal-status.dto";

// Aucune logique métier ici, même principe que CoachAthleteWeightsController :
// CoachAthleteAccessGuard devant GoalsService, réutilisé tel quel — mêmes
// DTO, même service. L'ownership goalId->athleteId et stepId->goalId (ticket
// §15) est déjà garantie par GoalsService (assertGoalBelongsToAthlete /
// stepBelongsToGoal, internes) : aucun contrôle supplémentaire à écrire ici.
@Controller("coach/athletes/:athleteId/goals")
@UseGuards(JwtAuthGuard, CoachAthleteAccessGuard)
export class CoachAthleteGoalsController {
  constructor(private readonly goalsService: GoalsService) {}

  @Post()
  createGoal(@Param("athleteId", ParseUUIDPipe) athleteId: string, @Body() dto: CreateGoalDto) {
    return this.goalsService.createGoal(athleteId, dto);
  }

  @Get()
  findAll(@Param("athleteId", ParseUUIDPipe) athleteId: string) {
    return this.goalsService.findAllForAthlete(athleteId);
  }

  @Patch(":goalId")
  updateStatus(
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
    @Param("goalId", ParseUUIDPipe) goalId: string,
    @Body() dto: UpdateGoalStatusDto,
  ) {
    return this.goalsService.updateStatus(athleteId, goalId, dto);
  }

  @Post(":goalId/steps")
  addStep(
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
    @Param("goalId", ParseUUIDPipe) goalId: string,
    @Body() dto: CreateGoalStepDto,
  ) {
    return this.goalsService.addStep(athleteId, goalId, dto);
  }

  @Patch(":goalId/steps/:stepId")
  updateStep(
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
    @Param("goalId", ParseUUIDPipe) goalId: string,
    @Param("stepId", ParseUUIDPipe) stepId: string,
    @Body() dto: UpdateGoalStepDto,
  ) {
    return this.goalsService.updateStep(athleteId, goalId, stepId, dto);
  }
}
