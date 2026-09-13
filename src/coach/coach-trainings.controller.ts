import {
  BadRequestException,
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
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGuard } from "../auth/coach.guard";
import { CoachTrainingOwnershipGuard } from "../auth/coach-training-ownership.guard";
import { CoachTrainingsService } from "./coach-trainings.service";
import { CreateCoachTrainingDto } from "./dto/create-coach-training.dto";
import { UpdateCoachTrainingDto } from "./dto/update-coach-training.dto";
import { ReplaceCoachTrainingAssignmentsDto } from "./dto/replace-coach-training-assignments.dto";

@Controller("coach/trainings")
@UseGuards(JwtAuthGuard)
export class CoachTrainingsController {
  constructor(private readonly trainingsService: CoachTrainingsService) {}

  @Post()
  @UseGuards(CoachGuard)
  create(@Req() req: Request, @Body() dto: CreateCoachTrainingDto) {
    return this.trainingsService.createTraining(req.user!.coachId!, req.user!.sub, dto);
  }

  // Jamais ?coachId= (ticket §11) : le coach vient exclusivement du JWT.
  @Get()
  @UseGuards(CoachGuard)
  findAll(@Req() req: Request, @Query("from") fromParam?: string, @Query("to") toParam?: string) {
    const range = parseRange(fromParam, toParam);
    return this.trainingsService.findAllForCoach(req.user!.coachId!, range);
  }

  @Get(":trainingId")
  @UseGuards(CoachTrainingOwnershipGuard)
  findOne(@Param("trainingId", ParseUUIDPipe) trainingId: string) {
    return this.trainingsService.findOneForCoach(trainingId);
  }

  @Patch(":trainingId")
  @UseGuards(CoachTrainingOwnershipGuard)
  updateContent(
    @Req() req: Request,
    @Param("trainingId", ParseUUIDPipe) trainingId: string,
    @Body() dto: UpdateCoachTrainingDto,
  ) {
    return this.trainingsService.updateContent(trainingId, req.user!.sub, dto);
  }

  @Put(":trainingId/assignments")
  @UseGuards(CoachTrainingOwnershipGuard)
  replaceAssignments(
    @Req() req: Request,
    @Param("trainingId", ParseUUIDPipe) trainingId: string,
    @Body() dto: ReplaceCoachTrainingAssignmentsDto,
  ) {
    return this.trainingsService.replaceAssignments(req.user!.coachId!, req.user!.sub, trainingId, dto);
  }

  // Annulation "douce" (voir CoachTrainingsRepository.cancel et rapport §16),
  // pas une suppression physique : la séance reste dans l'historique des
  // athlètes déjà assignés, seul son statut change.
  @Delete(":trainingId")
  @HttpCode(HttpStatus.OK)
  @UseGuards(CoachTrainingOwnershipGuard)
  cancel(@Req() req: Request, @Param("trainingId", ParseUUIDPipe) trainingId: string) {
    return this.trainingsService.cancel(trainingId, req.user!.sub);
  }
}

// Même convention que TrainingsController.parseRange (athlete-facing) :
// from/to doivent être fournis ensemble, from <= to. Dupliqué délibérément
// (logique de parsing HTTP locale au contrôleur, pas une règle métier — voir
// rapport §31 pour la justification de ne pas l'avoir extraite).
function parseRange(fromParam?: string, toParam?: string): { from: Date; to: Date } | undefined {
  if (fromParam === undefined && toParam === undefined) {
    return undefined;
  }

  const from = parseDate(fromParam, "from");
  const to = parseDate(toParam, "to");

  if (from > to) {
    throw new BadRequestException("Le paramètre from doit être antérieur ou égal à to");
  }

  return { from, to };
}

function parseDate(value: string | undefined, paramName: string): Date {
  if (value === undefined) {
    throw new BadRequestException(`Le paramètre ${paramName} est requis lorsque l'autre est fourni`);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`Le paramètre ${paramName} doit être une date valide`);
  }

  return date;
}
