import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { InternationalService } from "./international.service";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export function parsePositiveInt(value: string | undefined, name: string, fallback: number, max?: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || (max !== undefined && parsed > max)) {
    throw new BadRequestException(`Le paramètre ${name} doit être un entier entre 1 et ${max ?? "illimité"}`);
  }
  return parsed;
}

// Catalogue public/international global (jamais lié à un athlète EKVARA) :
// JwtAuthGuard seul, pas AthleteOwnershipGuard — même choix que
// GET /competitions/:id et GET /exercises.
@Controller("international-athletes")
@UseGuards(JwtAuthGuard)
export class InternationalAthletesController {
  constructor(private readonly internationalService: InternationalService) {}

  @Get(":id")
  findOne(@Param("id", ParseUUIDPipe) id: string) {
    return this.internationalService.getAthlete(id);
  }

  @Get(":id/matches")
  findMatches(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("page") pageParam?: string,
    @Query("limit") limitParam?: string,
  ) {
    return this.internationalService.getAthleteMatches(
      id,
      parsePositiveInt(pageParam, "page", 1),
      parsePositiveInt(limitParam, "limit", DEFAULT_LIMIT, MAX_LIMIT),
    );
  }
}
