import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "../../../generated/prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { MANUAL_SOURCE } from "../competitions/admin-competition-origin";
import { matchOrigin } from "./admin-match-rules";

export interface MatchData {
  category_label: string;
  bracket_stage: string | null;
  contest_number: number | null;
  athlete_a_id: string;
  athlete_b_id: string;
  score_a: number | null;
  score_b: number | null;
  winner_athlete_id: string | null;
  result_method: string | null;
  occurred_at: Date | null;
}

export class MatchNoLongerManualError extends Error {}

// Même forme que MATCH_INCLUDE (InternationalRepository) : réutilisation
// directe de toResultFightView.
export const ADMIN_MATCH_INCLUDE = {
  athlete_a: true,
  athlete_b: true,
  winner: true,
  sources: { orderBy: [{ created_at: "asc" as const }, { id: "asc" as const }] },
  competition: { select: { id: true, nom: true, date_debut: true, date_fin: true, lieu: true, ville: true, pays: true } },
} satisfies Prisma.competition_matchInclude;

const FACTS_SELECT = {
  id: true,
  athlete_a_id: true,
  athlete_b_id: true,
  score_a: true,
  score_b: true,
  winner_athlete_id: true,
  result_method: true,
  bracket_stage: true,
} satisfies Prisma.competition_matchSelect;

// Écritures du portail sur competition_match / competition_match_source.
// N'appelle JAMAIS InternationalRepository.saveMatchRepresentation (chemin de
// l'import WT, qui rattache automatiquement) ; ne modifie jamais un combat
// portant une représentation WT.
@Injectable()
export class AdminMatchesRepository {
  constructor(private readonly prisma: PrismaService) {}

  competition(competitionId: string) {
    return this.prisma.competition.findUnique({ where: { id: competitionId }, select: { id: true, date_debut: true, date_fin: true } });
  }

  athletes(ids: string[]) {
    return this.prisma.external_athlete.findMany({ where: { id: { in: ids } }, select: { id: true, display_name: true, country_code: true } });
  }

  findById(id: string) {
    return this.prisma.competition_match.findUnique({ where: { id }, include: ADMIN_MATCH_INCLUDE });
  }

  // Combats sans catégorie (absents du résumé public par catégorie).
  findUncategorized(competitionId: string) {
    return this.prisma.competition_match.findMany({ where: { competition_id: competitionId, category_label: null }, include: ADMIN_MATCH_INCLUDE });
  }

  // Clé logique de l'import WT : compétition, catégorie, n° de combat, paire
  // non ordonnée.
  findSameKey(competitionId: string, data: MatchData, excludeId?: string) {
    if (data.contest_number === null) return Promise.resolve([]);
    return this.prisma.competition_match.findMany({
      where: {
        competition_id: competitionId,
        category_label: data.category_label,
        contest_number: data.contest_number,
        OR: pairWhere(data),
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: FACTS_SELECT,
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
    });
  }

  findSamePair(competitionId: string, data: MatchData, excludeId?: string) {
    return this.prisma.competition_match.findMany({
      where: { competition_id: competitionId, OR: pairWhere(data), ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: FACTS_SELECT,
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      take: 50,
    });
  }

  findManyById(ids: string[]) {
    return this.prisma.competition_match.findMany({ where: { id: { in: ids } }, include: ADMIN_MATCH_INCLUDE });
  }

  // competition_match + sa représentation manuelle en UNE écriture atomique
  // (écriture imbriquée Prisma). id = source_external_id : identifiant
  // interne stable, sans collision possible avec un identifiant WT. Les
  // CHECK Postgres (A <> B, vainqueur ∈ {A, B}) restent le filet ultime.
  createManual(competitionId: string, data: MatchData) {
    const id = randomUUID();
    return this.prisma.competition_match.create({
      data: {
        id,
        competition_id: competitionId,
        source: MANUAL_SOURCE,
        source_external_id: id,
        source_url: null,
        result_method_raw: null,
        ...data,
        sources: { create: { source: MANUAL_SOURCE, source_external_id: id, source_url: null } },
      },
    });
  }

  // Origine revérifiée DANS la transaction : un import WT qui aurait
  // rattaché sa représentation entre-temps rend la modification impossible.
  async updateManual(id: string, data: MatchData) {
    await this.prisma.$transaction(async (tx) => {
      const sources = await tx.competition_match_source.findMany({ where: { competition_match_id: id }, select: { source: true } });
      if (matchOrigin(sources) !== "manual") throw new MatchNoLongerManualError();
      await tx.competition_match.update({ where: { id }, data: { ...data, updated_at: new Date() } });
    });
  }
}

function pairWhere(data: MatchData): Prisma.competition_matchWhereInput[] {
  return [
    { athlete_a_id: data.athlete_a_id, athlete_b_id: data.athlete_b_id },
    { athlete_a_id: data.athlete_b_id, athlete_b_id: data.athlete_a_id },
  ];
}
