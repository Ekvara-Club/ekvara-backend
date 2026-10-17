import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AdminGuard } from "../admin.guard";
import { AdminCompetitionsService } from "./admin-competitions.service";
import { AdminCompetitionCreateDto, AdminCompetitionListQueryDto, AdminCompetitionUpdateDto } from "./dto/admin-competition.dto";

// Compétitions du portail EkvaraAdmin. AdminGuard sur TOUTES les routes
// (session admin + jeton CSRF sur POST/PATCH). Les prévisualisations sont des
// POST sans aucune écriture (corps volumineux, jamais mis en cache).
@Controller("admin/competitions")
@UseGuards(AdminGuard)
export class AdminCompetitionsController {
  constructor(private readonly service: AdminCompetitionsService) {}

  @Get()
  list(@Query() query: AdminCompetitionListQueryDto) {
    return this.service.list(query);
  }

  // Déclarée avant :id (et :id exige un UUID).
  @Get("years")
  years() {
    return this.service.years();
  }

  @Post("preview")
  @HttpCode(HttpStatus.OK)
  previewCreate(@Body() dto: AdminCompetitionCreateDto) {
    return this.service.previewCreate(dto);
  }

  @Post()
  create(@Body() dto: AdminCompetitionCreateDto, @Req() req: Request) {
    return this.service.create(dto, req.admin!.userId);
  }

  @Get(":id")
  detail(@Param("id", ParseUUIDPipe) id: string) {
    return this.service.getDetail(id);
  }

  @Post(":id/preview")
  @HttpCode(HttpStatus.OK)
  previewUpdate(@Param("id", ParseUUIDPipe) id: string, @Body() dto: AdminCompetitionUpdateDto) {
    return this.service.previewUpdate(id, dto);
  }

  @Patch(":id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: AdminCompetitionUpdateDto, @Req() req: Request) {
    return this.service.update(id, dto, req.admin!.userId);
  }
}
