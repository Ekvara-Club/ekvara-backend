import { Injectable } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CalendarCandidate } from "./wt-results/wtr-competition-matcher";

export interface AthleteSourceInput {
  source: string;
  sourceExternalId: string;
  sourceUrl?: string | null;
  displayName: string;
  countryCode?: string | null;
  imageUrl?: string | null;
}

export interface MatchInput {
  competitionId: string;
  source: string;
  sourceExternalId: string;
  sourceUrl?: string | null;
  categoryLabel?: string | null;
  bracketStage?: string | null;
  contestNumber?: number | null;
  athleteAId: string;
  athleteBId: string;
  scoreA?: number | null;
  scoreB?: number | null;
  winnerAthleteId?: string | null;
  resultMethod?: string | null;
  resultMethodRaw?: string | null;
}

export interface ResultsSourceInput {
  competitionId: string;
  source: string;
  sourceExternalId: string;
  sourceUrl: string;
  rawName: string;
}

export type AttachOutcome = "attached" | "refreshed";

export class CompetitionSourceConflictError extends Error {}

const ATHLETE_INCLUDE = { sources: { orderBy: { created_at: "asc" as const } } };
const MATCH_INCLUDE = {
  athlete_a: true,
  athlete_b: true,
  winner: true,
  competition: { select: { id: true, nom: true, date_debut: true, date_fin: true } },
} satisfies Prisma.competition_matchInclude;

export type MatchWithRelations = Prisma.competition_matchGetPayload<{ include: typeof MATCH_INCLUDE }>;
export type AthleteWithSources = Prisma.external_athleteGetPayload<{ include: typeof ATHLETE_INCLUDE }>;

@Injectable()
export class InternationalRepository {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Athlètes externes
  // -------------------------------------------------------------------------

  // L'identité d'un athlète externe est EXCLUSIVEMENT (source, source_external_id).
  // Jamais de rapprochement par nom/pays/club : deux UUID différents portant le
  // même nom donnent deux external_athlete distincts ; un même UUID revu (autre
  // match, autre compétition, ré-import) retombe toujours sur le même.
  async upsertAthleteFromSource(input: AthleteSourceInput): Promise<{ athleteId: string; created: boolean }> {
    const existing = await this.findSource(input.source, input.sourceExternalId);
    if (existing) {
      await this.refreshExistingAthlete(existing.id, existing.external_athlete_id, input);
      return { athleteId: existing.external_athlete_id, created: false };
    }

    try {
      const athlete = await this.prisma.external_athlete.create({
        data: {
          display_name: input.displayName,
          country_code: input.countryCode ?? null,
          sources: {
            create: {
              source: input.source,
              source_external_id: input.sourceExternalId,
              source_url: input.sourceUrl ?? null,
              raw_name: input.displayName,
              image_url: input.imageUrl ?? null,
            },
          },
        },
      });
      return { athleteId: athlete.id, created: true };
    } catch (error) {
      // Course entre deux imports : l'autre a créé la source entre-temps.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await this.findSource(input.source, input.sourceExternalId);
        if (raced) {
          return { athleteId: raced.external_athlete_id, created: false };
        }
      }
      throw error;
    }
  }

  // Politique alignée sur competition (voir CompetitionsRepository) : une
  // source ne remplace jamais un champ canonique déjà renseigné, elle ne comble
  // que les null. Les champs raw_* de la ligne de source reflètent toujours la
  // dernière valeur vue chez CETTE source.
  private async refreshExistingAthlete(sourceRowId: string, athleteId: string, input: AthleteSourceInput) {
    await this.prisma.external_athlete_source.update({
      where: { id: sourceRowId },
      data: {
        raw_name: input.displayName,
        ...(input.imageUrl ? { image_url: input.imageUrl } : {}),
        ...(input.sourceUrl ? { source_url: input.sourceUrl } : {}),
      },
    });

    if (input.countryCode) {
      await this.prisma.external_athlete.updateMany({
        where: { id: athleteId, country_code: null },
        data: { country_code: input.countryCode },
      });
    }
  }

  // Snapshot du record V/D AFFICHÉ par la source (page profil), avec sa date de
  // relevé. Jamais recalculé à partir de nos matchs (jeu partiel).
  async saveRecordSnapshot(
    source: string,
    sourceExternalId: string,
    snapshot: { recordWins: number | null; recordLosses: number | null; syncedAt: Date },
  ): Promise<boolean> {
    const result = await this.prisma.external_athlete_source.updateMany({
      where: { source, source_external_id: sourceExternalId },
      data: {
        record_wins: snapshot.recordWins,
        record_losses: snapshot.recordLosses,
        record_synced_at: snapshot.syncedAt,
      },
    });
    return result.count === 1;
  }

  private findSource(source: string, sourceExternalId: string) {
    return this.prisma.external_athlete_source.findUnique({
      where: { source_source_external_id: { source, source_external_id: sourceExternalId } },
    });
  }

  findAthleteById(id: string): Promise<AthleteWithSources | null> {
    return this.prisma.external_athlete.findUnique({ where: { id }, include: ATHLETE_INCLUDE });
  }

  // -------------------------------------------------------------------------
  // Matchs
  // -------------------------------------------------------------------------

  async findExistingMatchIds(source: string, sourceExternalIds: string[]): Promise<Set<string>> {
    if (sourceExternalIds.length === 0) return new Set();
    const rows = await this.prisma.competition_match.findMany({
      where: { source, source_external_id: { in: sourceExternalIds } },
      select: { source_external_id: true },
    });
    return new Set(rows.map((r) => r.source_external_id));
  }

  // Identité logique = [source, source_external_id] (id du match chez la
  // source). Jamais noms + date.
  async upsertMatch(input: MatchInput): Promise<{ matchId: string; created: boolean }> {
    const data = {
      competition_id: input.competitionId,
      source_url: input.sourceUrl ?? null,
      category_label: input.categoryLabel ?? null,
      bracket_stage: input.bracketStage ?? null,
      contest_number: input.contestNumber ?? null,
      athlete_a_id: input.athleteAId,
      athlete_b_id: input.athleteBId,
      score_a: input.scoreA ?? null,
      score_b: input.scoreB ?? null,
      winner_athlete_id: input.winnerAthleteId ?? null,
      result_method: input.resultMethod ?? null,
      result_method_raw: input.resultMethodRaw ?? null,
    };

    const where = { source_source_external_id: { source: input.source, source_external_id: input.sourceExternalId } };
    const existing = await this.prisma.competition_match.findUnique({ where, select: { id: true } });
    if (existing) {
      await this.prisma.competition_match.update({ where: { id: existing.id }, data });
      return { matchId: existing.id, created: false };
    }

    try {
      const created = await this.prisma.competition_match.create({
        data: { ...data, source: input.source, source_external_id: input.sourceExternalId },
      });
      return { matchId: created.id, created: true };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await this.prisma.competition_match.findUnique({ where, select: { id: true } });
        if (raced) {
          await this.prisma.competition_match.update({ where: { id: raced.id }, data });
          return { matchId: raced.id, created: false };
        }
      }
      throw error;
    }
  }

  async findMatchesByAthlete(athleteId: string, page: number, limit: number) {
    const where: Prisma.competition_matchWhereInput = { OR: [{ athlete_a_id: athleteId }, { athlete_b_id: athleteId }] };
    return this.paginateMatches(where, page, limit);
  }

  async findMatchesByCompetition(competitionId: string, page: number, limit: number) {
    return this.paginateMatches({ competition_id: competitionId }, page, limit);
  }

  private async paginateMatches(where: Prisma.competition_matchWhereInput, page: number, limit: number) {
    const [items, total] = await Promise.all([
      this.prisma.competition_match.findMany({
        where,
        include: MATCH_INCLUDE,
        // Ordre stable : contest_number (nullable → en dernier) puis id, sans
        // prétendre à une chronologie que la source n'expose pas.
        orderBy: [{ contest_number: { sort: "asc", nulls: "last" } }, { id: "asc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.competition_match.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  async competitionExists(competitionId: string): Promise<boolean> {
    const found = await this.prisma.competition.findUnique({ where: { id: competitionId }, select: { id: true } });
    return found !== null;
  }

  // -------------------------------------------------------------------------
  // Rattachement d'une source Results à une competition CANONIQUE existante
  // -------------------------------------------------------------------------

  // Compétitions canoniques connues du calendrier WT (source "world_taekwondo")
  // qui commencent le même jour : simple pré-filtre pour le matcher pur. Ne
  // lit rien d'autre, ne modifie rien.
  async findCalendarCandidates(dateStart: Date): Promise<(CalendarCandidate & { calendarExternalIds: string[] })[]> {
    const rows = await this.prisma.competition.findMany({
      where: { date_debut: dateStart, sources: { some: { source: "world_taekwondo" } } },
      include: { sources: { where: { source: "world_taekwondo" }, select: { source_external_id: true } } },
    });
    return rows.map((c) => ({
      competitionId: c.id,
      nom: c.nom,
      dateDebut: c.date_debut,
      dateFin: c.date_fin,
      calendarExternalIds: c.sources.map((s) => s.source_external_id),
    }));
  }

  // Ajoute (ou rafraîchit) UNE ligne competition_source pour la source Results
  // sur la competition canonique DÉJÀ décidée SAFE par le matcher. Ne crée
  // jamais de competition, ne modifie jamais la ligne canonique ni les autres
  // sources (l'identité du calendrier WT reste intacte), et refuse de déplacer
  // un slug déjà rattaché à une AUTRE competition.
  async attachResultsSource(input: ResultsSourceInput): Promise<AttachOutcome> {
    const where = { source_source_external_id: { source: input.source, source_external_id: input.sourceExternalId } };
    const existing = await this.prisma.competition_source.findUnique({ where });

    if (existing) {
      if (existing.competition_id !== input.competitionId) {
        throw new CompetitionSourceConflictError(
          `${input.source}/${input.sourceExternalId} est déjà rattachée à la competition ${existing.competition_id}, refus de la déplacer vers ${input.competitionId}`,
        );
      }
      await this.prisma.competition_source.update({
        where: { id: existing.id },
        data: { source_url: input.sourceUrl, raw_nom: input.rawName },
      });
      return "refreshed";
    }

    await this.prisma.competition_source.create({
      data: {
        competition_id: input.competitionId,
        source: input.source,
        source_external_id: input.sourceExternalId,
        source_url: input.sourceUrl,
        raw_nom: input.rawName,
        // Même convention que CompetitionsRepository : "safe" = rattachée
        // automatiquement par un matcher.
        match_confidence: "safe",
      },
    });
    return "attached";
  }
}
