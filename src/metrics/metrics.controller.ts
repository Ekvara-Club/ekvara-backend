import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { AthleteOwnershipGuard } from "../auth/athlete-ownership.guard";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { MetricsService } from "./metrics.service";
import { CreateMeasurementDto } from "./dto/create-measurement.dto";

@Controller("athletes/:athleteId")
@UseGuards(JwtAuthGuard, AthleteOwnershipGuard)
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Post("metrics/:metricTypeId/measurements")
  createMeasurement(
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
    @Param("metricTypeId", ParseUUIDPipe) metricTypeId: string,
    @Body() dto: CreateMeasurementDto,
  ) {
    return this.metricsService.createMeasurement(athleteId, metricTypeId, dto);
  }

  @Get("metrics/:metricTypeId/measurements")
  findMeasurements(
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
    @Param("metricTypeId", ParseUUIDPipe) metricTypeId: string,
  ) {
    return this.metricsService.findMeasurements(athleteId, metricTypeId);
  }

  @Get("progress/highlights")
  getHighlights(@Param("athleteId", ParseUUIDPipe) athleteId: string) {
    return this.metricsService.getHighlights(athleteId);
  }

  // Contrairement à progress/highlights (uniquement les améliorations),
  // renvoie l'état de tous les metric_type connus, y compris ceux sans
  // aucune mesure pour cet athlète.
  @Get("metrics/overview")
  getOverview(@Param("athleteId", ParseUUIDPipe) athleteId: string) {
    return this.metricsService.getOverview(athleteId);
  }
}
