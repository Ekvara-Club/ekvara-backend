import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AdminGuard } from "../admin.guard";
import { AdminEntriesService } from "./admin-entries.service";
import { AdminEntryBulkDto } from "./dto/admin-entry-bulk.dto";
import { AdminEntryDto } from "./dto/admin-entry.dto";

// Participants (competition_entry) d'une compétition. AdminGuard sur TOUTES
// les routes (session admin + jeton CSRF sur POST/PATCH).
@Controller("admin")
@UseGuards(AdminGuard)
export class AdminEntriesController {
  constructor(private readonly service: AdminEntriesService) {}

  @Get("competitions/:competitionId/entries")
  list(@Param("competitionId", ParseUUIDPipe) competitionId: string) {
    return this.service.list(competitionId);
  }

  @Post("competitions/:competitionId/entries/preview")
  @HttpCode(HttpStatus.OK)
  previewCreate(@Param("competitionId", ParseUUIDPipe) competitionId: string, @Body() dto: AdminEntryDto) {
    return this.service.previewCreate(competitionId, dto);
  }

  @Post("competitions/:competitionId/entries")
  create(@Param("competitionId", ParseUUIDPipe) competitionId: string, @Body() dto: AdminEntryDto, @Req() req: Request) {
    return this.service.create(competitionId, dto, req.admin!.userId);
  }

  @Post("competitions/:competitionId/entries/bulk/preview")
  @HttpCode(HttpStatus.OK)
  previewBulk(@Param("competitionId", ParseUUIDPipe) competitionId: string, @Body() dto: AdminEntryBulkDto) {
    return this.service.previewBulk(competitionId, dto);
  }

  @Post("competitions/:competitionId/entries/bulk")
  createBulk(@Param("competitionId", ParseUUIDPipe) competitionId: string, @Body() dto: AdminEntryBulkDto, @Req() req: Request) {
    return this.service.createBulk(competitionId, dto, req.admin!.userId);
  }

  @Post("entries/:id/preview")
  @HttpCode(HttpStatus.OK)
  previewUpdate(@Param("id", ParseUUIDPipe) id: string, @Body() dto: AdminEntryDto) {
    return this.service.previewUpdate(id, dto);
  }

  @Patch("entries/:id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: AdminEntryDto, @Req() req: Request) {
    return this.service.update(id, dto, req.admin!.userId);
  }
}
