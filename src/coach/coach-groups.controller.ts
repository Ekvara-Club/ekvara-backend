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
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGuard } from "../auth/coach.guard";
import { CoachGroupOwnershipGuard } from "../auth/coach-group-ownership.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { CoachGroupsService } from "./coach-groups.service";
import { CoachGroupNameDto } from "./dto/coach-group-name.dto";

@Controller("coach/groups")
@UseGuards(JwtAuthGuard)
export class CoachGroupsController {
  constructor(private readonly coachGroupsService: CoachGroupsService) {}

  @Post()
  @UseGuards(CoachGuard)
  create(@Req() req: Request, @Body() dto: CoachGroupNameDto) {
    return this.coachGroupsService.createGroup(req.user!.coachId!, dto.name);
  }

  @Get()
  @UseGuards(CoachGuard)
  list(@Req() req: Request) {
    return this.coachGroupsService.listGroups(req.user!.coachId!);
  }

  @Get(":groupId")
  @UseGuards(CoachGroupOwnershipGuard)
  getDetail(@Param("groupId", ParseUUIDPipe) groupId: string) {
    return this.coachGroupsService.getGroupDetail(groupId);
  }

  @Patch(":groupId")
  @UseGuards(CoachGroupOwnershipGuard)
  rename(@Param("groupId", ParseUUIDPipe) groupId: string, @Body() dto: CoachGroupNameDto) {
    return this.coachGroupsService.renameGroup(groupId, dto.name);
  }

  @Delete(":groupId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(CoachGroupOwnershipGuard)
  remove(@Param("groupId", ParseUUIDPipe) groupId: string) {
    return this.coachGroupsService.deleteGroup(groupId);
  }

  // CoachGroupOwnershipGuard vérifie que :groupId appartient au coach ;
  // CoachAthleteAccessGuard vérifie que :athleteId lui est assigné (voir
  // CoachAthleteAccessGuard, qui lit indifféremment params.athleteId). Les
  // deux ensemble empêchent tout ajout d'un athlète non autorisé (ticket
  // §25), sans aucun contrôle dupliqué dans le service.
  @Post(":groupId/athletes/:athleteId")
  @UseGuards(CoachGroupOwnershipGuard, CoachAthleteAccessGuard)
  addAthlete(
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
  ) {
    return this.coachGroupsService.addAthlete(groupId, athleteId);
  }

  @Delete(":groupId/athletes/:athleteId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(CoachGroupOwnershipGuard, CoachAthleteAccessGuard)
  removeAthlete(
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("athleteId", ParseUUIDPipe) athleteId: string,
  ) {
    return this.coachGroupsService.removeAthlete(groupId, athleteId);
  }
}
