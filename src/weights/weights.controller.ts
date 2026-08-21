import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { AthleteOwnershipGuard } from "../auth/athlete-ownership.guard";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { WeightsService } from "./weights.service";
import { CreateWeightLogDto } from "./dto/create-weight-log.dto";
import { CreateWeightTargetDto } from "./dto/create-weight-target.dto";

@Controller("athletes/:athleteId")
@UseGuards(JwtAuthGuard, AthleteOwnershipGuard)
export class WeightsController {
  constructor(private readonly weightsService: WeightsService) {}

  @Post("weights")
  createWeightLog(
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
    @Body() dto: CreateWeightLogDto,
  ) {
    return this.weightsService.createWeightLog(athleteId, dto);
  }

  @Get("weights")
  findWeightLogs(@Param("athleteId", ParseUUIDPipe) athleteId: string) {
    return this.weightsService.findWeightLogsForAthlete(athleteId);
  }

  @Post("weight-targets")
  createWeightTarget(
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
    @Body() dto: CreateWeightTargetDto,
  ) {
    return this.weightsService.createWeightTarget(athleteId, dto);
  }

  @Get("weight-summary")
  getWeightSummary(@Param("athleteId", ParseUUIDPipe) athleteId: string) {
    return this.weightsService.getWeightSummary(athleteId);
  }
}
