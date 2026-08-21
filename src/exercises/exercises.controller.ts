import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ExercisesService } from "./exercises.service";

// Catalogue global (pas de relation à athlete) : JwtAuthGuard seul, sans
// AthleteOwnershipGuard puisqu'aucun exercice n'appartient à un athlète.
@Controller("exercises")
@UseGuards(JwtAuthGuard)
export class ExercisesController {
  constructor(private readonly exercisesService: ExercisesService) {}

  @Get()
  findAll() {
    return this.exercisesService.findAll();
  }

  @Get(":id")
  findOne(@Param("id", ParseUUIDPipe) id: string) {
    return this.exercisesService.findOne(id);
  }
}
