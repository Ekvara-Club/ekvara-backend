import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { AthleteOwnershipGuard } from "../auth/athlete-ownership.guard";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { GoalsService } from "./goals.service";
import { CreateGoalDto } from "./dto/create-goal.dto";
import { CreateGoalStepDto } from "./dto/create-goal-step.dto";
import { UpdateGoalStepDto } from "./dto/update-goal-step.dto";
import { UpdateGoalStatusDto } from "./dto/update-goal-status.dto";

@Controller("athletes/:athleteId/goals")
@UseGuards(JwtAuthGuard, AthleteOwnershipGuard)
export class GoalsController {
  constructor(private readonly goalsService: GoalsService) {}

  @Post()
  createGoal(@Param("athleteId", ParseUUIDPipe) athleteId: string, @Body() dto: CreateGoalDto) {
    return this.goalsService.createGoal(athleteId, dto);
  }

  @Get()
  findAll(@Param("athleteId", ParseUUIDPipe) athleteId: string) {
    return this.goalsService.findAllForAthlete(athleteId);
  }

  @Get("active")
  async findActive(@Param("athleteId", ParseUUIDPipe) athleteId: string, @Res() res: Response) {
    const result = await this.goalsService.findActiveForAthlete(athleteId);
    // Cf. ParticipationsController.findNext : Nest renvoie un corps vide (pas
    // `null` en JSON) quand le contrôleur retourne null. On force une réponse
    // JSON `null` explicite (200, jamais 404) quand il n'y a pas d'objectif actif.
    res.status(200).json(result);
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

  @Patch(":goalId")
  updateStatus(
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
    @Param("goalId", ParseUUIDPipe) goalId: string,
    @Body() dto: UpdateGoalStatusDto,
  ) {
    return this.goalsService.updateStatus(athleteId, goalId, dto);
  }
}
