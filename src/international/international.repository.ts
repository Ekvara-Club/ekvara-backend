import { Injectable } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CalendarCandidate } from "./wt-results/wtr-competition-matcher";
import { diffMatchFacts, hasLogicalKey, MatchFacts, reconcileMatch } from "./wt-results/wtr-match-reconciliation";

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

// created    : nouveau combat (aucun combat existant partageant la clé) ;
// attached   : SAME_LOGICAL_FIGHT — l'identifiant source est rattaché au
//              competition_match existant (aucune ligne créée) ;
// refreshed  : représentation déjà connue, revue ;
// conflict   : la clé correspond mais un attribut critique diverge — NON fusionné,
//              données conservées (nouveau combat, ou ligne inchangée au refresh) ;
// ambiguous  : plusieurs combats existants cohérents — aucun choix arbitraire,
//              représentation conservée dans un nouveau combat.
export type MatchSaveOutcome = "created" | "attached" | "refreshed" | "conflict" | "ambiguous";

export interface MatchSaveResult {
  matchId: string;
  // true SEULEMENT si une ligne competition_match a été créée.
  created: boolean;
  outcome: MatchSaveOutcome;
  // Attributs critiques divergents (conflit) ; vide sinon.
  differences: string[];
  // Combats existants concernés par un conflit/une ambiguïté.
  relatedMatchIds: string[];
}

export class CompetitionSourceConflictError extends Error {}

const ATHLETE_INCLUDE = { sources: { orderBy: { created_at: "asc" as const } } };
const MATCH_INCLUDE = {
  athlete_a: true,
  athlete_b: true,
  winner: true,
  // TOUTES les représentations source du combat (provenance complète).
  sources: { orderBy: [{ created_at: "asc" as const }, { id: "asc" as const }] },
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

  // Identifiants de match source DÉJÀ connus, qu'ils soient la représentation
  // principale d'un combat ou une représentation rattachée (competition_match_source).
  async findExistingMatchIds(source: string, sourceExternalIds: string[]): Promise<Set<string>> {
    if (sourceExternalIds.length === 0) return new Set();
    const [attached, primary] = await Promise.all([
      this.prisma.competition_match_source.findMany({
        where: { source, source_external_id: { in: sourceExternalIds } },
        select: { source_external_id: true },
      }),
      this.prisma.competition_match.findMany({
        where: { source, source_external_id: { in: sourceExternalIds } },
        select: { source_external_id: true },
      }),
    ]);
    return new Set([...attached, ...primary].map((r) => r.source_external_id));
  }

  // Enregistre UNE représentation source (un id de match WT Results). L'identité
  // d'une représentation est [source, source_external_id] ; l'identité du combat
  // RÉEL est rapprochée de façon conservatrice par la clé
  // (competition, category, contest_number, paire non ordonnée d'athlètes) puis
  // validée attribut par attribut (voir wtr-match-reconciliation) — jamais une
  // fusion de force, jamais une contrainte UNIQUE sur cette clé.
  async saveMatchRepresentation(input: MatchInput): Promise<MatchSaveResult> {
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
    const facts: MatchFacts = {
      athleteAId: input.athleteAId,
      athleteBId: input.athleteBId,
      scoreA: input.scoreA ?? null,
      scoreB: input.scoreB ?? null,
      winnerAthleteId: input.winnerAthleteId ?? null,
      resultMethod: input.resultMethod ?? null,
      bracketStage: input.bracketStage ?? null,
    };

    const known = await this.findKnownRepresentation(input.source, input.sourceExternalId);
    if (known) return this.refreshKnownRepresentation(known, data, facts);

    const representation = {
      source: input.source,
      source_external_id: input.sourceExternalId,
      source_url: input.sourceUrl ?? null,
    };

    if (hasLogicalKey({ categoryLabel: data.category_label, contestNumber: data.contest_number })) {
      const candidates = await this.prisma.competition_match.findMany({
        where: {
          competition_id: input.competitionId,
          category_label: data.category_label,
          contest_number: data.contest_number,
          OR: [
            { athlete_a_id: input.athleteAId, athlete_b_id: input.athleteBId },
            { athlete_a_id: input.athleteBId, athlete_b_id: input.athleteAId },
          ],
        },
        select: {
          id: true,
          athlete_a_id: true,
          athlete_b_id: true,
          score_a: true,
          score_b: true,
          winner_athlete_id: true,
          result_method: true,
          bracket_stage: true,
        },
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
      });

      const decision = reconcileMatch(
        facts,
        candidates.map((c) => ({
          matchId: c.id,
          facts: {
            athleteAId: c.athlete_a_id,
            athleteBId: c.athlete_b_id,
            scoreA: c.score_a,
            scoreB: c.score_b,
            winnerAthleteId: c.winner_athlete_id,
            resultMethod: c.result_method,
            bracketStage: c.bracket_stage,
          },
        })),
      );

      if (decision.kind === "SAME_LOGICAL_FIGHT") {
        try {
          await this.prisma.competition_match_source.create({
            data: { competition_match_id: decision.matchId, ...representation },
          });
        } catch (error) {
          return this.recoverFromRace(error, input, data, facts);
        }
        return { matchId: decision.matchId, created: false, outcome: "attached", differences: [], relatedMatchIds: [] };
      }

      if (decision.kind === "CONFLICT" || decision.kind === "AMBIGUOUS") {
        const created = await this.createMatchWithRepresentation(input, data, representation, facts);
        if ("raced" in created) return created.raced;
        return decision.kind === "CONFLICT"
          ? { matchId: created.matchId, created: true, outcome: "conflict", differences: decision.differences, relatedMatchIds: decision.conflictingMatchIds }
          : { matchId: created.matchId, created: true, outcome: "ambiguous", differences: [], relatedMatchIds: decision.matchIds };
      }
    }

    const created = await this.createMatchWithRepresentation(input, data, representation, facts);
    if ("raced" in created) return created.raced;
    return { matchId: created.matchId, created: true, outcome: "created", differences: [], relatedMatchIds: [] };
  }

  // competition_match + sa première représentation dans UNE seule écriture
  // atomique. competition_match.source/source_external_id restent la
  // représentation retenue à la création (comportement historique inchangé).
  private async createMatchWithRepresentation(
    input: MatchInput,
    data: Omit<Prisma.competition_matchUncheckedCreateInput, "source" | "source_external_id">,
    representation: { source: string; source_external_id: string; source_url: string | null },
    facts: MatchFacts,
  ): Promise<{ matchId: string } | { raced: MatchSaveResult }> {
    try {
      const created = await this.prisma.competition_match.create({
        data: { ...data, ...representation, sources: { create: representation } },
      });
      return { matchId: created.id };
    } catch (error) {
      return { raced: await this.recoverFromRace(error, input, data, facts) };
    }
  }

  // Deux exécutions concurrentes de la MÊME représentation : la contrainte
  // unique (source, source_external_id) reste le filet, on retombe alors sur le
  // chemin "représentation déjà connue".
  private async recoverFromRace(
    error: unknown,
    input: MatchInput,
    data: Omit<Prisma.competition_matchUncheckedCreateInput, "source" | "source_external_id">,
    facts: MatchFacts,
  ): Promise<MatchSaveResult> {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await this.findKnownRepresentation(input.source, input.sourceExternalId);
      if (raced) return this.refreshKnownRepresentation(raced, data, facts);
    }
    throw error;
  }

  private async findKnownRepresentation(source: string, sourceExternalId: string) {
    const select = {
      id: true,
      athlete_a_id: true,
      athlete_b_id: true,
      score_a: true,
      score_b: true,
      winner_athlete_id: true,
      result_method: true,
      bracket_stage: true,
      _count: { select: { sources: true } },
    } satisfies Prisma.competition_matchSelect;

    const viaSource = await this.prisma.competition_match_source.findUnique({
      where: { source_source_external_id: { source, source_external_id: sourceExternalId } },
      select: { competition_match: { select } },
    });
    if (viaSource) return viaSource.competition_match;

    // Ligne antérieure à competition_match_source (représentation principale
    // sans ligne de provenance) : on la rétablit, elle reste la même identité.
    const legacy = await this.prisma.competition_match.findUnique({
      where: { source_source_external_id: { source, source_external_id: sourceExternalId } },
      select: { ...select, source_url: true },
    });
    if (!legacy) return null;
    await this.prisma.competition_match_source.createMany({
      data: [{ competition_match_id: legacy.id, source, source_external_id: sourceExternalId, source_url: legacy.source_url }],
      skipDuplicates: true,
    });
    const { source_url: _ignored, ...rest } = legacy;
    void _ignored;
    return { ...rest, _count: { sources: Math.max(rest._count.sources, 1) } };
  }

  // Représentation déjà connue : refresh. Un combat qui n'a QU'UNE représentation
  // est mis à jour (correction de la source). Un combat qui en a plusieurs n'est
  // JAMAIS écrasé par une seule d'entre elles si elle diverge : conflit signalé,
  // données conservées.
  private async refreshKnownRepresentation(
    known: {
      id: string;
      athlete_a_id: string;
      athlete_b_id: string;
      score_a: number | null;
      score_b: number | null;
      winner_athlete_id: string | null;
      result_method: string | null;
      bracket_stage: string | null;
      _count: { sources: number };
    },
    data: Omit<Prisma.competition_matchUncheckedCreateInput, "source" | "source_external_id">,
    facts: MatchFacts,
  ): Promise<MatchSaveResult> {
    const differences = diffMatchFacts(facts, {
      athleteAId: known.athlete_a_id,
      athleteBId: known.athlete_b_id,
      scoreA: known.score_a,
      scoreB: known.score_b,
      winnerAthleteId: known.winner_athlete_id,
      resultMethod: known.result_method,
      bracketStage: known.bracket_stage,
    });

    if (differences.length > 0 && known._count.sources > 1) {
      return { matchId: known.id, created: false, outcome: "conflict", differences, relatedMatchIds: [known.id] };
    }

    await this.prisma.competition_match.update({ where: { id: known.id }, data });
    return { matchId: known.id, created: false, outcome: "refreshed", differences: [], relatedMatchIds: [] };
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
