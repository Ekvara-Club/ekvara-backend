import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { CoachTrainingAttendanceService } from "./coach-training-attendance.service";

// Même pattern que CoachAthleteWeightsController (aucune logique métier
// ici) — coachId vient exclusivement du JWT (jamais un paramètre), pour que
// le résumé reste scopé aux SEULES séances programmées par CE coach (voir
// CoachTrainingAttendanceRepository.findEligibleSessionsForSummary).
@Controller("coach/athletes/:athleteId")
@UseGuards(JwtAuthGuard, CoachAthleteAccessGuard)
export class CoachAthleteAttendanceController {
  constructor(private readonly attendanceService: CoachTrainingAttendanceService) {}

  @Get("attendance/summary")
  getSummary(@Req() req: Request, @Param("athleteId", ParseUUIDPipe) athleteId: string) {
    return this.attendanceService.getAthleteSummary(req.user!.coachId!, athleteId);
  }
}
