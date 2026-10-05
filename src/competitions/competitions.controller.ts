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
import { HttpImportsGuard } from "./http-imports.guard";

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

@Controller("competitions")
export class CompetitionsController {
  constructor(
    private readonly competitionsService: CompetitionsService,
    private readonly competitionEntriesService: CompetitionEntriesService,
  ) {}

  // ?search= seul : comportement historique inchangé (recherche catalogue
  // "+ Préparer une compétition" côté coach, ticket Sélection & préparation
  // V1 §23 — jamais paginé, capé à 20 résultats côté repository).
  //
  // ?page=&limit=(&scope=&search=) : pagination réelle (ticket "Compétitions
  // Athlete V2" §8) pour le nouvel explorateur — activée UNIQUEMENT si page
  // ou limit est explicitement fourni, jamais par défaut. GET /competitions
  // reste public, pas de guard ajouté ici.
  @Get()
  findAll(
    @Query("search") search?: string,
    @Query("page") pageParam?: string,
    @Query("limit") limitParam?: string,
    @Query("scope") scope?: string,
    @Query("year") yearParam?: string,
  ) {
    if (pageParam === undefined && limitParam === undefined) {
      return this.competitionsService.findAll(search);
    }

    const page = this.parsePositiveInt(pageParam, "page", 1);
    const limit = this.parsePositiveInt(limitParam, "limit", 20, 50);

    if (scope !== undefined && scope !== "upcoming" && scope !== "past") {
      throw new BadRequestException('Le paramètre scope doit valoir "upcoming" ou "past"');
    }

    // year (optionnel, ticket #18) : année de date_debut, compose avec scope
    // et search ; mêmes bornes que l'import World Taekwondo.
    const year = yearParam === undefined || yearParam === "" ? undefined : this.parseYear(yearParam);

    return this.competitionsService.findAllPaginated({
      search,
      page,
      limit,
      scope: scope as "upcoming" | "past" | undefined,
      year,
    });
  }

  // Années disponibles pour le filtre de l'explorateur (ticket #18) : public,
  // comme GET /competitions. Déclarée AVANT :competitionId pour ne jamais être
  // interprétée comme un identifiant.
  @Get("years")
  listYears() {
    return this.competitionsService.listYears();
  }

  private parsePositiveInt(value: string | undefined, name: string, fallback: number, max?: number): number {
    if (value === undefined || value === "") {
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || (max !== undefined && parsed > max)) {
      throw new BadRequestException(
        `Le paramètre ${name} doit être un entier entre 1 et ${max ?? "illimité"}`,
      );
    }
    return parsed;
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
  @UseGuards(HttpImportsGuard)
  importFftda() {
    return this.competitionsService.importFftda();
  }

  @Post("import/world-taekwondo")
  @UseGuards(HttpImportsGuard)
  importWorldTaekwondo(@Query("year") yearParam?: string) {
    const year = this.parseYear(yearParam);
    return this.competitionsService.importWorldTaekwondo(year);
  }

  @Post("import/martial-events")
  @UseGuards(HttpImportsGuard)
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
