import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { MetricsService } from "../metrics/metrics.service";
import { CreateMeasurementDto } from "../metrics/dto/create-measurement.dto";

// Aucune logique métier ici, même principe que les tickets #5 (poids/
// objectifs) : CoachAthleteAccessGuard devant MetricsService, réutilisé tel
// quel. Seule différence avec une simple délégation 1:1 : `coachUserId` du
// body est TOUJOURS ignoré et remplacé par req.user.sub (ticket §9) — jamais
// une valeur choisie par le client, même si CreateMeasurementDto l'autorise
// pour le flux athlete existant (voir commentaire sur createMeasurement).
@Controller("coach/athletes/:athleteId/metrics")
@UseGuards(JwtAuthGuard, CoachAthleteAccessGuard)
export class CoachAthleteMetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get("overview")
  getOverview(@Param("athleteId", ParseUUIDPipe) athleteId: string) {
    return this.metricsService.getOverview(athleteId);
  }

  @Get(":metricTypeId/measurements")
  findMeasurements(
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
    @Param("metricTypeId", ParseUUIDPipe) metricTypeId: string,
  ) {
    return this.metricsService.findMeasurements(athleteId, metricTypeId);
  }

  @Post(":metricTypeId/measurements")
  createMeasurement(
    @Req() req: Request,
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
    @Param("metricTypeId", ParseUUIDPipe) metricTypeId: string,
    @Body() dto: CreateMeasurementDto,
  ) {
    // Sécurité (ticket §9/§21) : coachUserId vient TOUJOURS du token, jamais
    // du body — même si le DTO (partagé avec le flux athlete) accepte ce
    // champ. Un coach ne peut jamais faire passer une autre identité comme
    // auteur de la mesure.
    return this.metricsService.createMeasurement(athleteId, metricTypeId, {
      ...dto,
      coachUserId: req.user!.sub,
    });
  }
}
