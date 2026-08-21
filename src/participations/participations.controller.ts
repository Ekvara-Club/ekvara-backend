import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { AthleteOwnershipGuard } from "../auth/athlete-ownership.guard";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ParticipationsService } from "./participations.service";
import { CreateParticipationDto } from "./dto/create-participation.dto";
import { UpdateParticipationResultDto } from "./dto/update-participation-result.dto";

@Controller("athletes/:athleteId/competitions")
@UseGuards(JwtAuthGuard, AthleteOwnershipGuard)
export class ParticipationsController {
  constructor(private readonly participationsService: ParticipationsService) {}

  @Post(":competitionId/participate")
  participate(
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
    @Param("competitionId", ParseUUIDPipe) competitionId: string,
    @Body() dto: CreateParticipationDto,
  ) {
    return this.participationsService.participate(athleteId, competitionId, dto);
  }

  @Get()
  findAll(@Param("athleteId", ParseUUIDPipe) athleteId: string) {
    return this.participationsService.findAllForAthlete(athleteId);
  }

  @Get("next")
  async findNext(@Param("athleteId", ParseUUIDPipe) athleteId: string, @Res() res: Response) {
    const result = await this.participationsService.findNextForAthlete(athleteId);
    // Nest renvoie un corps vide (pas `null` en JSON) quand le contrôleur retourne
    // null (cf. isNil(body) => response.send() dans l'adapter Express). On force
    // ici une réponse JSON `null` explicite, conforme au contrat attendu par le
    // dashboard (200 + null plutôt que 404) quand l'athlète n'a pas de prochaine compétition.
    res.status(200).json(result);
  }

  @Patch(":competitionId/result")
  updateResult(
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
    @Param("competitionId", ParseUUIDPipe) competitionId: string,
    @Body() dto: UpdateParticipationResultDto,
  ) {
    return this.participationsService.updateResult(athleteId, competitionId, dto);
  }
}
