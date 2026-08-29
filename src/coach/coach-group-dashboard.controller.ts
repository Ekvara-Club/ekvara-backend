import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGroupOwnershipGuard } from "../auth/coach-group-ownership.guard";
import { CoachGroupDashboardService } from "./coach-group-dashboard.service";

// Route dédiée /coach/groups/:groupId/dashboard (ticket "Dashboard groupe
// Coach V1" §3/§5) : fait évoluer /groups/:groupId existant, jamais une
// route /analytics/... parallèle. CoachGroupOwnershipGuard réutilisé tel
// quel (même garde que GET/PATCH/DELETE /coach/groups/:groupId) : 403,
// jamais 404, pour un groupe inconnu ou appartenant à un autre coach.
@Controller("coach/groups")
@UseGuards(JwtAuthGuard)
export class CoachGroupDashboardController {
  constructor(private readonly service: CoachGroupDashboardService) {}

  // Jamais ?coachId= : le coach vient exclusivement du JWT, même politique
  // que tous les autres contrôleurs coach de ce projet.
  @Get(":groupId/dashboard")
  @UseGuards(CoachGroupOwnershipGuard)
  getDashboard(@Req() req: Request, @Param("groupId", ParseUUIDPipe) groupId: string) {
    return this.service.getGroupDashboard(req.user!.coachId!, groupId);
  }
}
