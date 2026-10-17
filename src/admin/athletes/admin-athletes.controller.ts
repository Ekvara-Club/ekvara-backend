import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AdminGuard } from "../admin.guard";
import { AdminAthletesService } from "./admin-athletes.service";
import { AdminAthleteCreateDto, AdminAthleteListQueryDto, AdminAthleteUpdateDto } from "./dto/admin-athlete.dto";

// Athlètes internationaux (external_athlete) du portail EkvaraAdmin.
// AdminGuard sur TOUTES les routes (session admin + jeton CSRF sur
// POST/PATCH). Aucune route ne crée ni ne lit de compte EKVARA.
@Controller("admin/athletes")
@UseGuards(AdminGuard)
export class AdminAthletesController {
  constructor(private readonly service: AdminAthletesService) {}

  @Get()
  list(@Query() query: AdminAthleteListQueryDto) {
    return this.service.list(query);
  }

  // Déclarée avant :id (et :id exige un UUID).
  @Get("countries")
  countries() {
    return this.service.countries();
  }

  @Post("preview")
  @HttpCode(HttpStatus.OK)
  previewCreate(@Body() dto: AdminAthleteCreateDto) {
    return this.service.previewCreate(dto);
  }

  @Post()
  create(@Body() dto: AdminAthleteCreateDto, @Req() req: Request) {
    return this.service.create(dto, req.admin!.userId);
  }

  @Get(":id")
  profile(@Param("id", ParseUUIDPipe) id: string) {
    return this.service.getProfile(id);
  }

  @Post(":id/preview")
  @HttpCode(HttpStatus.OK)
  previewUpdate(@Param("id", ParseUUIDPipe) id: string, @Body() dto: AdminAthleteUpdateDto) {
    return this.service.previewUpdate(id, dto);
  }

  @Patch(":id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: AdminAthleteUpdateDto, @Req() req: Request) {
    return this.service.update(id, dto, req.admin!.userId);
  }
}
