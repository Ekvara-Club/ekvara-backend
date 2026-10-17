import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AdminGuard } from "../admin.guard";
import { AdminMatchesService } from "./admin-matches.service";
import { AdminMatchDto } from "./dto/admin-match.dto";

const MAX_CATEGORY_LENGTH = 100;

// Combats (competition_match) d'une compétition. AdminGuard sur TOUTES les
// routes (session admin + jeton CSRF sur POST/PATCH).
@Controller("admin")
@UseGuards(AdminGuard)
export class AdminMatchesController {
  constructor(private readonly service: AdminMatchesService) {}

  @Get("competitions/:competitionId/matches")
  summary(@Param("competitionId", ParseUUIDPipe) competitionId: string) {
    return this.service.summary(competitionId);
  }

  // ?category=<libellé exact> ou ?uncategorized=true (combats sans catégorie).
  @Get("competitions/:competitionId/matches/list")
  list(
    @Param("competitionId", ParseUUIDPipe) competitionId: string,
    @Query("category") category?: string,
    @Query("uncategorized") uncategorized?: string,
  ) {
    if (uncategorized === "true") return this.service.listCategory(competitionId, null);
    if (category === undefined || category.trim() === "" || category.length > MAX_CATEGORY_LENGTH) {
      throw new BadRequestException(`Le paramètre category doit contenir entre 1 et ${MAX_CATEGORY_LENGTH} caractères`);
    }
    return this.service.listCategory(competitionId, category);
  }

  @Post("competitions/:competitionId/matches/preview")
  @HttpCode(HttpStatus.OK)
  previewCreate(@Param("competitionId", ParseUUIDPipe) competitionId: string, @Body() dto: AdminMatchDto) {
    return this.service.previewCreate(competitionId, dto);
  }

  @Post("competitions/:competitionId/matches")
  create(@Param("competitionId", ParseUUIDPipe) competitionId: string, @Body() dto: AdminMatchDto, @Req() req: Request) {
    return this.service.create(competitionId, dto, req.admin!.userId);
  }

  @Get("matches/:id")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Post("matches/:id/preview")
  @HttpCode(HttpStatus.OK)
  previewUpdate(@Param("id", ParseUUIDPipe) id: string, @Body() dto: AdminMatchDto) {
    return this.service.previewUpdate(id, dto);
  }

  @Patch("matches/:id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: AdminMatchDto, @Req() req: Request) {
    return this.service.update(id, dto, req.admin!.userId);
  }
}
