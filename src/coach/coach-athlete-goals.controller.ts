import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { GoalsService } from "../goals/goals.service";
import { CreateGoalDto } from "../goals/dto/create-goal.dto";
import { CreateGoalStepDto } from "../goals/dto/create-goal-step.dto";
import { UpdateGoalStepDto } from "../goals/dto/update-goal-step.dto";
import { UpdateGoalStatusDto } from "../goals/dto/update-goal-status.dto";
import { NotificationsService } from "../notifications/notifications.service";
import { GOAL_RESOURCE, GOAL_UPDATED } from "../notifications/notification.constants";

// Aucune logique métier ici, même principe que CoachAthleteWeightsController :
// CoachAthleteAccessGuard devant GoalsService, réutilisé tel quel — mêmes
// DTO, même service. L'ownership goalId->athleteId et stepId->goalId (ticket
// §15) est déjà garantie par GoalsService (assertGoalBelongsToAthlete /
// stepBelongsToGoal, internes) : aucun contrôle supplémentaire à écrire ici.
//
// Ticket "Notifications in-app..." : l'orchestration de notification vit ICI
// (contrôleur coach), jamais dans GoalsService — ce service est PARTAGÉ avec
// GoalsController (athlete self-service, voir ticket §31 "goals création
// coach") : y ajouter une notification notifierait un athlète de ses PROPRES
// actions. Compromis transactionnel documenté (ticket "TRANSACTIONS") :
// GoalsService.createGoal/updateStatus n'ouvrent pas de transaction propre,
// la notification est donc envoyée APRÈS un succès déjà acquis, jamais dans
// la même transaction Prisma — un échec d'insertion notification n'annule
// jamais la mutation goal, seulement documenté comme limite connue.
@Controller("coach/athletes/:athleteId/goals")
@UseGuards(JwtAuthGuard, CoachAthleteAccessGuard)
export class CoachAthleteGoalsController {
  constructor(
    private readonly goalsService: GoalsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  @Post()
  async createGoal(@Req() req: Request, @Param("athleteId", ParseUUIDPipe) athleteId: string, @Body() dto: CreateGoalDto) {
    const created = await this.goalsService.createGoal(athleteId, dto);
    await this.notificationsService.notifyAthletes([athleteId], {
      actorUserId: req.user!.sub,
      context: "ATHLETE",
      type: GOAL_UPDATED,
      title: "Nouvel objectif",
      message: `Ton coach a créé un nouvel objectif : "${dto.titre}".`,
      resourceType: GOAL_RESOURCE,
      resourceId: created.id,
    });
    return created;
  }

  @Get()
  findAll(@Param("athleteId", ParseUUIDPipe) athleteId: string) {
    return this.goalsService.findAllForAthlete(athleteId);
  }

  @Patch(":goalId")
  async updateStatus(
    @Req() req: Request,
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
    @Param("goalId", ParseUUIDPipe) goalId: string,
    @Body() dto: UpdateGoalStatusDto,
  ) {
    // Idempotence (ticket) : comparé au statut ACTUEL, jamais notifié
    // uniquement parce que l'endpoint a été appelé. La liste complète des
    // objectifs est déjà exposée par GoalsService.findAllForAthlete (utilisée
    // telle quelle par le frontend athlète) — aucune méthode
    // GoalsService supplémentaire nécessaire pour ce diff.
    const existing = await this.goalsService.findAllForAthlete(athleteId);
    const before = existing.find((g) => g.id === goalId);

    const updated = await this.goalsService.updateStatus(athleteId, goalId, dto);

    if (before && before.statut !== dto.statut) {
      await this.notificationsService.notifyAthletes([athleteId], {
        actorUserId: req.user!.sub,
        context: "ATHLETE",
        type: GOAL_UPDATED,
        title: "Objectif mis à jour",
        message: `Le statut de ton objectif "${updated.titre}" a été mis à jour.`,
        resourceType: GOAL_RESOURCE,
        resourceId: goalId,
      });
    }

    return updated;
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
