import { Body, Controller, Get, Put, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGuard } from "../auth/coach.guard";
import { MetricsService } from "../metrics/metrics.service";
import { PutClubMetricScalesDto } from "./dto/put-club-metric-scales.dto";

// Barème de l'étoile de compétences du CLUB du coach connecté (jamais un
// clubId venant du client : déduit de coach_profile.club_id).
@Controller("coach/metric-scales")
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachMetricScalesController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  get(@Req() req: Request) {
    return this.metricsService.getClubScales(req.user!.coachId!);
  }

  @Put()
  save(@Req() req: Request, @Body() dto: PutClubMetricScalesDto) {
    return this.metricsService.saveClubScales(req.user!.coachId!, req.user!.sub, dto.scales);
  }
}
