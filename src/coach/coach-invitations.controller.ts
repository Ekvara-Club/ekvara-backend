import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGuard } from "../auth/coach.guard";
import { CoachInvitationOwnershipGuard } from "../auth/coach-invitation-ownership.guard";
import { InvitationsService } from "../invitations/invitations.service";
import { CreateInvitationDto } from "../invitations/dto/create-invitation.dto";

@Controller("coach/invitations")
@UseGuards(JwtAuthGuard)
export class CoachInvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Post()
  @UseGuards(CoachGuard)
  create(@Req() req: Request, @Body() dto: CreateInvitationDto) {
    return this.invitationsService.createInvitation(req.user!.coachId!, dto.assignedGroupId);
  }

  @Get()
  @UseGuards(CoachGuard)
  list(@Req() req: Request) {
    return this.invitationsService.listInvitations(req.user!.coachId!);
  }

  // CoachInvitationOwnershipGuard vérifie déjà que req.user.coachId est
  // présent ET que l'invitation lui appartient : aucun CoachGuard séparé
  // nécessaire ici (même convention que CoachGroupOwnershipGuard sur
  // /coach/groups/:groupId).
  @Patch(":invitationId/revoke")
  @HttpCode(HttpStatus.OK)
  @UseGuards(CoachInvitationOwnershipGuard)
  async revoke(@Param("invitationId", ParseUUIDPipe) invitationId: string) {
    await this.invitationsService.revoke(invitationId);
    return { success: true };
  }
}
