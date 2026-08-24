import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ExercisesService } from "./exercises.service";

// Catalogue global + exercices coach publiés à CET athlète (voir ticket
// "Bibliothèque d'exercices Coach") : JwtAuthGuard seul, sans
// AthleteOwnershipGuard — aucun :athleteId dans l'URL, la visibilité dépend
// uniquement de l'identité du token (athleteId, optionnel : un coach-only
// obtient le catalogue global sans planter, voir ExercisesService).
@Controller("exercises")
@UseGuards(JwtAuthGuard)
export class ExercisesController {
  constructor(private readonly exercisesService: ExercisesService) {}

  @Get()
  findAll(@Req() req: Request) {
    return this.exercisesService.findAll(req.user!.athleteId);
  }

  @Get(":id")
  findOne(@Param("id", ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.exercisesService.findOne(id, req.user!.athleteId);
  }
}
