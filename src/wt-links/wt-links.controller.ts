import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AthleteOwnershipGuard } from "../auth/athlete-ownership.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { WtLinksService } from "./wt-links.service";
import { RequestWtLinkDto } from "./dto/request-wt-link.dto";

// Côté athlète : seul l'athlète lui-même consulte, réclame ou retire SON
// lien (ownership). Le lien n'est jamais confirmé ici.
@Controller("athletes/:athleteId/wt-profile")
@UseGuards(JwtAuthGuard, AthleteOwnershipGuard)
export class AthleteWtLinkController {
  constructor(private readonly service: WtLinksService) {}

  @Get()
  get(@Param("athleteId", ParseUUIDPipe) athleteId: string) {
    return this.service.getForAthlete(athleteId);
  }

  @Put()
  request(@Req() req: Request, @Param("athleteId", ParseUUIDPipe) athleteId: string, @Body() dto: RequestWtLinkDto) {
    return this.service.request(athleteId, req.user!.sub, dto.externalAthleteId);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  unlink(@Param("athleteId", ParseUUIDPipe) athleteId: string) {
    return this.service.unlink(athleteId);
  }
}

// Côté coach : confirme ou refuse la demande d'un athlète qu'il suit
// (CoachAthleteAccessGuard : 403 sinon).
@Controller("coach/athletes/:athleteId/wt-profile")
@UseGuards(JwtAuthGuard, CoachAthleteAccessGuard)
export class CoachWtLinkController {
  constructor(private readonly service: WtLinksService) {}

  @Post("confirm")
  @HttpCode(HttpStatus.OK)
  async confirm(@Req() req: Request, @Param("athleteId", ParseUUIDPipe) athleteId: string) {
    await this.service.decide(athleteId, req.user!.sub, "confirm");
    return { status: "confirmed" };
  }

  @Post("reject")
  @HttpCode(HttpStatus.OK)
  async reject(@Req() req: Request, @Param("athleteId", ParseUUIDPipe) athleteId: string) {
    await this.service.decide(athleteId, req.user!.sub, "reject");
    return { status: "rejected" };
  }
}
