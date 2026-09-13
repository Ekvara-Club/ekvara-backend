import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { WeightsService } from "../weights/weights.service";
import { CreateWeightTargetDto } from "../weights/dto/create-weight-target.dto";
import { NotificationsService } from "../notifications/notifications.service";
import { WEIGHT_TARGET_RESOURCE, WEIGHT_TARGET_UPDATED } from "../notifications/notification.constants";

// Aucune logique métier ici : ce contrôleur n'est QUE l'autorisation coach
// (CoachAthleteAccessGuard) posée devant WeightsService, réutilisé tel quel
// — même DTO, même service, même comportement que le contrôleur athlete
// (voir ticket §4 "Ne pas dupliquer la logique métier"). Ne touche jamais
// weight_log (ticket §5, MVP : poids piloté = uniquement l'objectif).
//
// Ticket "Notifications in-app..." : orchestration ICI (jamais dans
// WeightsService, partagé avec le contrôleur athlete self-service — voir
// même justification que CoachAthleteGoalsController). WeightsRepository.
// replaceActiveWeightTarget crée TOUJOURS une nouvelle ligne, même avec des
// valeurs identiques (aucune idempotence native) : le "vrai changement"
// (ticket "IDEMPOTENCE") est donc détecté ICI en comparant l'objectif actif
// AVANT l'appel à celui obtenu APRÈS. Compromis transactionnel identique à
// CoachAthleteGoalsController (documenté dans le rapport final).
@Controller("coach/athletes/:athleteId")
@UseGuards(JwtAuthGuard, CoachAthleteAccessGuard)
export class CoachAthleteWeightsController {
  constructor(
    private readonly weightsService: WeightsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  @Get("weight")
  getWeightSummary(@Param("athleteId", ParseUUIDPipe) athleteId: string) {
    return this.weightsService.getWeightSummary(athleteId);
  }

  @Post("weight-targets")
  async createWeightTarget(
    @Req() req: Request,
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
    @Body() dto: CreateWeightTargetDto,
  ) {
    const before = await this.weightsService.getWeightSummary(athleteId);
    const created = await this.weightsService.createWeightTarget(athleteId, dto);

    if (hasRealTargetChange(before.target, created)) {
      await this.notificationsService.notifyAthletes([athleteId], {
        actorUserId: req.user!.sub,
        context: "ATHLETE",
        type: WEIGHT_TARGET_UPDATED,
        title: "Objectif de poids mis à jour",
        // Message neutre (ticket §WEIGHT_TARGET) : jamais de valeur chiffrée
        // ni de formulation culpabilisante ("Tu dois perdre X kg").
        message: "Ton objectif de poids a été mis à jour.",
        resourceType: WEIGHT_TARGET_RESOURCE,
        resourceId: created.id,
      });
    }

    return created;
  }
}

function hasRealTargetChange(
  before: { weight: number; targetDate: Date | null; competitionId: string | null } | null,
  after: { weight: number; targetDate: Date | null; competitionId: string | null },
): boolean {
  if (!before) {
    return true;
  }
  const beforeTargetTime = before.targetDate ? before.targetDate.getTime() : null;
  const afterTargetTime = after.targetDate ? after.targetDate.getTime() : null;
  return (
    before.weight !== after.weight ||
    beforeTargetTime !== afterTargetTime ||
    (before.competitionId ?? null) !== (after.competitionId ?? null)
  );
}
