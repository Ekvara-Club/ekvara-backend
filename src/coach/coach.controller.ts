import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGuard } from "../auth/coach.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { AthletesService } from "../athletes/athletes.service";
import { CoachService } from "./coach.service";

// Toutes les routes /coach/* exigent JwtAuthGuard. Le second guard varie par
// route : CoachGuard pour les routes sans athleteId (vérifie juste
// user.coachId), CoachAthleteAccessGuard pour celles avec :athleteId
// (vérifie en plus qu'une ligne coach_athlete existe — voir
// src/auth/coach-athlete-access.guard.ts). Jamais AthleteOwnershipGuard ici :
// il compare athleteId à sub, une notion qui n'a pas de sens côté coach.
@Controller("coach")
@UseGuards(JwtAuthGuard)
export class CoachController {
  constructor(
    private readonly coachService: CoachService,
    private readonly athletesService: AthletesService,
  ) {}

  @Get("me")
  @UseGuards(CoachGuard)
  getMe(@Req() req: Request) {
    return this.coachService.getMe(req.user!.coachId!);
  }

  // Pas de POST /coach/athletes : un athlète rejoint un coach UNIQUEMENT en
  // s'inscrivant avec le code d'invitation de ce coach (son accord explicite).
  // L'ancien ajout par email laissait n'importe quel coach s'attribuer
  // n'importe quel athlète, et donc ses données de santé.

  @Get("athletes")
  @UseGuards(CoachGuard)
  listAthletes(@Req() req: Request) {
    return this.coachService.listAthletes(req.user!.coachId!);
  }

  @Delete("athletes/:athleteId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(CoachAthleteAccessGuard)
  removeAthlete(@Req() req: Request, @Param("athleteId", ParseUUIDPipe) athleteId: string) {
    return this.coachService.removeAthlete(req.user!.coachId!, athleteId);
  }

  // Validation verticale du guard (voir ticket §20) : réutilise
  // AthletesService.findOne() sans aucune logique dupliquée, seule
  // l'autorisation change par rapport à GET /athletes/:id.
  @Get("athletes/:athleteId")
  @UseGuards(CoachAthleteAccessGuard)
  getAthlete(@Param("athleteId", ParseUUIDPipe) athleteId: string) {
    return this.athletesService.findOne(athleteId);
  }
}
