import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Put, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { deleteAthleteAccount, exportAthleteData } from "./athletes.service";
import { authCookieNameFor, buildLogoutCookieOptions } from "../auth/auth.cookie";
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
  constructor(
    private readonly athletesService: AthletesService,
    private readonly prisma: PrismaService,
  ) {}

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

  // RGPD — droit d'accès : téléchargement de toutes ses données (JSON).
  @Get(":id/export")
  @UseGuards(JwtAuthGuard, AthleteOwnershipGuard)
  exportData(@Param("id", ParseUUIDPipe) id: string) {
    return exportAthleteData(this.prisma, id);
  }

  // RGPD — droit à l'effacement : suppression définitive du compte et de
  // toutes ses données. Confirmation explicite exigée dans le corps.
  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, AthleteOwnershipGuard)
  async deleteAccount(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { confirm?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    if (body?.confirm !== "SUPPRIMER") {
      throw new BadRequestException('Confirmation requise : envoie { "confirm": "SUPPRIMER" }');
    }
    await deleteAthleteAccount(this.prisma, id);
    // Session athlète fermée : le compte n'existe plus.
    res.clearCookie(authCookieNameFor("athlete"), buildLogoutCookieOptions());
    return { deleted: true };
  }
}

