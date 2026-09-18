import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { parsePositiveInt } from "./international-athletes.controller";
import { InternationalService } from "./international.service";

// Même préfixe que CompetitionsController (route distincte :competitionId/matches,
// aucune modification du contrôleur existant). Les matchs appartiennent à la
// compétition canonique (donnée globale) : JwtAuthGuard seul, comme
// GET /competitions/:competitionId/entries.
@Controller("competitions")
@UseGuards(JwtAuthGuard)
export class CompetitionMatchesController {
  constructor(private readonly internationalService: InternationalService) {}

  @Get(":competitionId/matches")
  findMatches(
    @Param("competitionId", ParseUUIDPipe) competitionId: string,
    @Query("page") pageParam?: string,
    @Query("limit") limitParam?: string,
  ) {
    return this.internationalService.getCompetitionMatches(
      competitionId,
      parsePositiveInt(pageParam, "page", 1),
      parsePositiveInt(limitParam, "limit", 20, 50),
    );
  }
}
