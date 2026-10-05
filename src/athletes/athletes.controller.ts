import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AthleteOwnershipGuard } from "../auth/athlete-ownership.guard";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AthletesService } from "./athletes.service";
import { UpdateAthleteConditionDto } from "./dto/update-athlete-condition.dto";

// POST /athletes (création publique, sans invitation) a été retiré (voir
// ticket "Clubs, invitations & inscription Athlete contrôlée V1"
// §"SUPPRIMER L'INSCRIPTION ATHLETE LIBRE") : la seule voie de création
// d'athlete reste désormais POST /auth/register, qui exige une invitation de
// club valide. AthletesService.create reste utilisable en interne (voir
// AuthService.register) mais n'est plus exposé publiquement.
@Controller("athletes")
export class AthletesController {
  constructor(private readonly athletesService: AthletesService) {}

  // Le paramètre s'appelle `id` (pas `athleteId`) : AthleteOwnershipGuard
  // gère les deux noms.
  @Get(":id")
  @UseGuards(JwtAuthGuard, AthleteOwnershipGuard)
  findOne(@Param("id", ParseUUIDPipe) id: string) {
    return this.athletesService.findOne(id);
  }

  // État de forme : seul l'athlète lui-même le déclare (ownership), ses
  // coachs le lisent via leurs propres vues (dashboard, fiche athlète).
  @Put(":id/condition")
  @UseGuards(JwtAuthGuard, AthleteOwnershipGuard)
  updateCondition(
    @Req() req: Request,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateAthleteConditionDto,
  ) {
    return this.athletesService.updateCondition(id, req.user!.sub, dto);
  }
}
