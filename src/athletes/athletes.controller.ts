import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { AthleteOwnershipGuard } from "../auth/athlete-ownership.guard";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AthletesService } from "./athletes.service";
import { CreateAthleteDto } from "./dto/create-athlete.dto";

@Controller("athletes")
export class AthletesController {
  constructor(private readonly athletesService: AthletesService) {}

  @Post()
  create(@Body() dto: CreateAthleteDto) {
    return this.athletesService.create(dto);
  }

  // Le paramètre s'appelle `id` (pas `athleteId`) : AthleteOwnershipGuard
  // gère les deux noms.
  @Get(":id")
  @UseGuards(JwtAuthGuard, AthleteOwnershipGuard)
  findOne(@Param("id", ParseUUIDPipe) id: string) {
    return this.athletesService.findOne(id);
  }
}
