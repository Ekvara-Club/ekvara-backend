import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGuard } from "../auth/coach.guard";
import { CoachCompetitionOwnershipGuard } from "../auth/coach-competition-ownership.guard";
import { CoachCompetitionsService } from "./coach-competitions.service";

// Lecture seule (ticket Compétitions Coach V1 §19) : aucune mutation, jamais
// d'inscription/retrait/résultat depuis ce contrôleur.
@Controller("coach/competitions")
@UseGuards(JwtAuthGuard)
export class CoachCompetitionsController {
  constructor(private readonly competitionsService: CoachCompetitionsService) {}

  // Jamais ?coachId= (même politique que CoachTrainingsController) : le
  // coach vient exclusivement du JWT. Toujours les deux groupes upcoming/past
  // ensemble (voir CoachCompetitionsService) : la page /competitions en a
  // besoin simultanément, un seul aller-retour suffit.
  @Get()
  @UseGuards(CoachGuard)
  findAll(@Req() req: Request) {
    return this.competitionsService.getCompetitions(req.user!.coachId!);
  }

  @Get(":competitionId")
  @UseGuards(CoachCompetitionOwnershipGuard)
  findOne(@Req() req: Request, @Param("competitionId", ParseUUIDPipe) competitionId: string) {
    return this.competitionsService.getCompetitionDetail(req.user!.coachId!, competitionId);
  }
}
