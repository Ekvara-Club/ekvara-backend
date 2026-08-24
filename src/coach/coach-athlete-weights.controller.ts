import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { WeightsService } from "../weights/weights.service";
import { CreateWeightTargetDto } from "../weights/dto/create-weight-target.dto";

// Aucune logique métier ici : ce contrôleur n'est QUE l'autorisation coach
// (CoachAthleteAccessGuard) posée devant WeightsService, réutilisé tel quel
// — même DTO, même service, même comportement que le contrôleur athlete
// (voir ticket §4 "Ne pas dupliquer la logique métier"). Ne touche jamais
// weight_log (ticket §5, MVP : poids piloté = uniquement l'objectif).
@Controller("coach/athletes/:athleteId")
@UseGuards(JwtAuthGuard, CoachAthleteAccessGuard)
export class CoachAthleteWeightsController {
  constructor(private readonly weightsService: WeightsService) {}

  @Get("weight")
  getWeightSummary(@Param("athleteId", ParseUUIDPipe) athleteId: string) {
    return this.weightsService.getWeightSummary(athleteId);
  }

  @Post("weight-targets")
  createWeightTarget(
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
    @Body() dto: CreateWeightTargetDto,
  ) {
    return this.weightsService.createWeightTarget(athleteId, dto);
  }
}
