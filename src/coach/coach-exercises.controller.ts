import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGuard } from "../auth/coach.guard";
import { CoachExerciseOwnershipGuard } from "../auth/coach-exercise-ownership.guard";
import { CoachExercisesService } from "./coach-exercises.service";
import { CreateCoachExerciseDto } from "./dto/create-coach-exercise.dto";
import { UpdateCoachExerciseDto } from "./dto/update-coach-exercise.dto";
import { ReplaceCoachExerciseAssignmentsDto } from "./dto/replace-coach-exercise-assignments.dto";

@Controller("coach/exercises")
@UseGuards(JwtAuthGuard)
export class CoachExercisesController {
  constructor(private readonly exercisesService: CoachExercisesService) {}

  @Post()
  @UseGuards(CoachGuard)
  create(@Req() req: Request, @Body() dto: CreateCoachExerciseDto) {
    return this.exercisesService.createExercise(req.user!.coachId!, dto);
  }

  // Uniquement les exercices créés par CE coach (ticket §8) — jamais le
  // catalogue global entier, qui reste servi par GET /exercises.
  @Get()
  @UseGuards(CoachGuard)
  findLibrary(@Req() req: Request) {
    return this.exercisesService.findLibraryForCoach(req.user!.coachId!);
  }

  @Get(":exerciseId")
  @UseGuards(CoachExerciseOwnershipGuard)
  findOne(@Param("exerciseId", ParseUUIDPipe) exerciseId: string) {
    return this.exercisesService.findOneForCoach(exerciseId);
  }

  @Patch(":exerciseId")
  @UseGuards(CoachExerciseOwnershipGuard)
  updateContent(@Param("exerciseId", ParseUUIDPipe) exerciseId: string, @Body() dto: UpdateCoachExerciseDto) {
    return this.exercisesService.updateContent(exerciseId, dto);
  }

  @Put(":exerciseId/assignments")
  @UseGuards(CoachExerciseOwnershipGuard)
  replaceAssignments(
    @Req() req: Request,
    @Param("exerciseId", ParseUUIDPipe) exerciseId: string,
    @Body() dto: ReplaceCoachExerciseAssignmentsDto,
  ) {
    return this.exercisesService.replaceAssignments(req.user!.coachId!, req.user!.sub, exerciseId, dto);
  }

  // Suppression physique (voir CoachExercisesRepository.delete et rapport
  // §13) : contrairement aux séances, un exercice n'est pas un historique
  // daté d'athlète — sa suppression est un vrai retrait, pas une annulation.
  @Delete(":exerciseId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(CoachExerciseOwnershipGuard)
  remove(@Param("exerciseId", ParseUUIDPipe) exerciseId: string) {
    return this.exercisesService.deleteExercise(exerciseId);
  }
}
