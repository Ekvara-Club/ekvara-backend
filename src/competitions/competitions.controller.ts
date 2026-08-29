import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CompetitionsService } from "./competitions.service";
import { CompetitionEntriesService } from "./competition-entries.service";

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

@Controller("competitions")
export class CompetitionsController {
  constructor(
    private readonly competitionsService: CompetitionsService,
    private readonly competitionEntriesService: CompetitionEntriesService,
  ) {}

  // ?search= : recherche catalogue pour "+ Préparer une compétition" côté
  // coach (ticket Sélection & préparation V1 §23) — ajout additif,
  // comportement inchangé sans le paramètre (voir CompetitionsRepository.
  // findMany : GET /competitions reste public, pas de guard ajouté ici).
  @Get()
  findAll(@Query("search") search?: string) {
    return this.competitionsService.findAll(search);
  }

  // Catalogue global (ownership non pertinent) mais fiche appartenant à
  // l'application authentifiée : JwtAuthGuard seul, pas
  // AthleteOwnershipGuard. GET /competitions reste volontairement public
  // (comportement existant, non modifié par cette route).
  @Get(":competitionId")
  @UseGuards(JwtAuthGuard)
  findOne(@Param("competitionId", ParseUUIDPipe) competitionId: string) {
    return this.competitionsService.findOne(competitionId);
  }

  // Les entries appartiennent à la compétition (donnée globale), pas à un
  // athlète : même protection que la fiche compétition elle-même —
  // JwtAuthGuard seul, jamais AthleteOwnershipGuard.
  @Get(":competitionId/entries")
  @UseGuards(JwtAuthGuard)
  findEntries(@Param("competitionId", ParseUUIDPipe) competitionId: string) {
    return this.competitionEntriesService.findByCompetition(competitionId);
  }

  @Post("import/fftda")
  importFftda() {
    return this.competitionsService.importFftda();
  }

  @Post("import/world-taekwondo")
  importWorldTaekwondo(@Query("year") yearParam?: string) {
    const year = this.parseYear(yearParam);
    return this.competitionsService.importWorldTaekwondo(year);
  }

  @Post("import/martial-events")
  importMartialEvents() {
    return this.competitionsService.importMartialEvents();
  }

  private parseYear(yearParam?: string): number {
    if (yearParam === undefined || yearParam === "") {
      return new Date().getFullYear();
    }

    const year = Number(yearParam);
    if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
      throw new BadRequestException(
        `Le paramètre year doit être un entier entre ${MIN_YEAR} et ${MAX_YEAR}`,
      );
    }

    return year;
  }
}
