import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from "@nestjs/common";
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

  // Résultats de l'événement : sans ?category, résumé (totaux + catégories) ;
  // avec ?category=<label stocké exact>, les combats de cette seule catégorie
  // groupés par tour (volume borné par catégorie, jamais tout l'événement).
  @Get(":competitionId/results")
  findResults(@Param("competitionId", ParseUUIDPipe) competitionId: string, @Query("category") categoryParam?: string) {
    if (categoryParam !== undefined && (categoryParam.trim() === "" || categoryParam.length > MAX_CATEGORY_LENGTH)) {
      throw new BadRequestException(`Le paramètre category doit contenir entre 1 et ${MAX_CATEGORY_LENGTH} caractères`);
    }
    return categoryParam === undefined
      ? this.internationalService.getCompetitionResultsSummary(competitionId)
      : this.internationalService.getCompetitionCategoryResults(competitionId, categoryParam);
  }
}

// = longueur de competition_match.category_label (VarChar(100)).
const MAX_CATEGORY_LENGTH = 100;
