import { Body, Controller, Delete, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGuard } from "../auth/coach.guard";
import { CoachPreparationOwnershipGuard } from "../auth/coach-preparation-ownership.guard";
import { CoachCompetitionPreparationsService } from "./coach-competition-preparations.service";
import { CreateCoachCompetitionPreparationDto } from "./dto/create-coach-competition-preparation.dto";
import { UpdateCoachCompetitionPreparationDto } from "./dto/update-coach-competition-preparation.dto";

// Pas de GET .../preparations dédié : la lecture se fait déjà via
// GET /coach/competitions/:competitionId (CoachCompetitionsService fusionne
// les préparations dans les lignes athlete[], voir ce service) — un second
// endpoint de lecture ne serait consommé par aucune UI (ticket §16 : "ne pas
// créer des endpoints juste pour suivre l'exemple").
@Controller("coach/competitions/:competitionId/preparations")
@UseGuards(JwtAuthGuard)
export class CoachCompetitionPreparationsController {
  constructor(private readonly preparationsService: CoachCompetitionPreparationsService) {}

  // Volontairement PAS de CoachCompetitionOwnershipGuard ici (ticket §21) :
  // créer la toute première préparation d'une compétition doit être possible
  // avant qu'aucune participation ni préparation n'existe encore pour cette
  // compétition côté roster de ce coach — seul CoachGuard (coach authentifié)
  // protège cette route, la propriété de l'athlete est vérifiée en service.
  @Post()
  @UseGuards(CoachGuard)
  create(
    @Req() req: Request,
    @Param("competitionId", ParseUUIDPipe) competitionId: string,
    @Body() dto: CreateCoachCompetitionPreparationDto,
  ) {
    return this.preparationsService.createPreparation(req.user!.coachId!, competitionId, dto);
  }

  @Patch(":preparationId")
  @UseGuards(CoachPreparationOwnershipGuard)
  update(@Param("preparationId", ParseUUIDPipe) preparationId: string, @Body() dto: UpdateCoachCompetitionPreparationDto) {
    return this.preparationsService.updatePreparation(preparationId, dto);
  }

  // "Retirer de la préparation" (ticket §15) : hard delete de cette seule
  // ligne, jamais participation/athlete/coach_athlete touchés (voir
  // CoachCompetitionPreparationsService.deletePreparation).
  @Delete(":preparationId")
  @UseGuards(CoachPreparationOwnershipGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param("preparationId", ParseUUIDPipe) preparationId: string) {
    return this.preparationsService.deletePreparation(preparationId);
  }
}
