import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { AthleteOwnershipGuard } from "../auth/athlete-ownership.guard";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { TrainingsService } from "./trainings.service";
import { CreateTrainingDto } from "./dto/create-training.dto";

@Controller("athletes/:athleteId/trainings")
@UseGuards(JwtAuthGuard, AthleteOwnershipGuard)
export class TrainingsController {
  constructor(private readonly trainingsService: TrainingsService) {}

  @Post()
  createTraining(
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
    @Body() dto: CreateTrainingDto,
  ) {
    return this.trainingsService.createTraining(athleteId, dto);
  }

  @Get()
  findAll(
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
    @Query("from") fromParam?: string,
    @Query("to") toParam?: string,
  ) {
    const range = this.parseRange(fromParam, toParam);
    return this.trainingsService.findAllForAthlete(athleteId, range);
  }

  @Get("next")
  async findNext(@Param("athleteId", ParseUUIDPipe) athleteId: string, @Res() res: Response) {
    const result = await this.trainingsService.findNextForAthlete(athleteId);
    // Cf. ParticipationsController.findNext / GoalsController.findActive : Nest
    // renvoie un corps vide (pas `null` en JSON) quand le contrôleur retourne
    // null. On force une réponse JSON `null` explicite (200, jamais 404).
    res.status(200).json(result);
  }

  private parseRange(
    fromParam?: string,
    toParam?: string,
  ): { from: Date; to: Date } | undefined {
    if (fromParam === undefined && toParam === undefined) {
      return undefined;
    }

    const from = this.parseDate(fromParam, "from");
    const to = this.parseDate(toParam, "to");

    if (from > to) {
      throw new BadRequestException("Le paramètre from doit être antérieur ou égal à to");
    }

    return { from, to };
  }

  private parseDate(value: string | undefined, paramName: string): Date {
    if (value === undefined) {
      throw new BadRequestException(
        `Le paramètre ${paramName} est requis lorsque l'autre est fourni`,
      );
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`Le paramètre ${paramName} doit être une date valide`);
    }

    return date;
  }
}
