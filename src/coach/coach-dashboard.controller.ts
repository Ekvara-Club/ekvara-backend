import { Controller, Get, Param, ParseUUIDPipe, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGuard } from "../auth/coach.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { CoachDashboardService } from "./coach-dashboard.service";
import { DashboardAthletesQueryDto } from "./dto/dashboard-athletes-query.dto";

// Couche de LECTURE agrégée uniquement (ticket #2) : aucune écriture ici.
// GET /coach/dashboard : cockpit global du coach (résumé + groupes + à venir).
// GET /coach/dashboard/athletes(?groupId=) : liste enrichie, pour une grille/
// tableau — jamais embarquée dans /coach/dashboard lui-même (voir ticket §15,
// contrat GET /coach/athletes existant volontairement non touché).
// GET /coach/athletes/:athleteId/dashboard : même agrégat, un seul athlète.
@Controller("coach")
@UseGuards(JwtAuthGuard)
export class CoachDashboardController {
  constructor(private readonly dashboardService: CoachDashboardService) {}

  @Get("dashboard")
  @UseGuards(CoachGuard)
  getDashboard(@Req() req: Request) {
    return this.dashboardService.getDashboard(req.user!.coachId!);
  }

  @Get("dashboard/athletes")
  @UseGuards(CoachGuard)
  getAthletes(@Req() req: Request, @Query() query: DashboardAthletesQueryDto) {
    return this.dashboardService.getAthleteSummaries(req.user!.coachId!, query.groupId);
  }

  @Get("athletes/:athleteId/dashboard")
  @UseGuards(CoachAthleteAccessGuard)
  getAthleteDashboard(@Req() req: Request, @Param("athleteId", ParseUUIDPipe) athleteId: string) {
    return this.dashboardService.getAthleteDashboard(req.user!.coachId!, athleteId);
  }
}
