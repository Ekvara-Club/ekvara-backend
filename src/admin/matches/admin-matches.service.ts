import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../../../generated/prisma/client";
import { InternationalRepository, MatchWithRelations } from "../../international/international.repository";
import { compareCategoryLabels, stageRank, toResultFightView } from "../../international/international.service";
import { AdminAuditLogger } from "../admin-audit.logger";
import { analyseMatchDuplicates, MatchCandidateRef, matchOrigin } from "./admin-match-rules";
import { AdminMatchesRepository, MatchData, MatchNoLongerManualError } from "./admin-matches.repository";
import { AdminMatchDto } from "./dto/admin-match.dto";

export const MATCH_EXISTS_MESSAGE = "Ce combat existe déjà (mêmes athlètes, catégorie, numéro de combat et résultat) : aucune création";
export const MATCH_DUPLICATES_MESSAGE = "Combat(s) potentiellement identique(s) ou en conflit : vérifiez-les et confirmez explicitement avant d'enregistrer";
export const IMPORTED_MATCH_MESSAGE = "Combat importé de World Taekwondo : lecture seule";
export const SAME_ATHLETE_MESSAGE = "Un athlète ne peut pas combattre contre lui-même";

@Injectable()
export class AdminMatchesService {
  constructor(
    private readonly repository: AdminMatchesRepository,
    private readonly international: InternationalRepository,
    private readonly audit: AdminAuditLogger,
  ) {}

  // Résumé par catégorie (requête publique réutilisée) + combats sans catégorie.
  async summary(competitionId: string) {
    await this.competition(competitionId);
    const [summary, uncategorized] = await Promise.all([
      this.international.summarizeCompetitionResults(competitionId),
      this.repository.findUncategorized(competitionId),
    ]);
    return {
      competitionId,
      matchCount: summary.fights,
      categories: summary.categories
        .filter((c): c is { category_label: string; fights: number; athletes: number } => c.category_label !== null)
        .map((c) => ({ label: c.category_label, fightCount: c.fights }))
        .sort((a, b) => compareCategoryLabels(a.label, b.label)),
      uncategorizedCount: uncategorized.length,
    };
  }

  // Combats d'une catégorie (ou sans catégorie), dans l'ordre du tableau.
  async listCategory(competitionId: string, category: string | null) {
    await this.competition(competitionId);
    const matches =
      category === null ? await this.repository.findUncategorized(competitionId) : await this.international.findCompetitionCategoryMatches(competitionId, category);
    return {
      competitionId,
      category,
      items: matches
        .map(toAdminMatchView)
        .sort(
          (a, b) =>
            stageRank(a.stage) - stageRank(b.stage) ||
            (a.contestNumber ?? Number.MAX_SAFE_INTEGER) - (b.contestNumber ?? Number.MAX_SAFE_INTEGER) ||
            a.id.localeCompare(b.id),
        ),
    };
  }

  async get(id: string) {
    const match = await this.repository.findById(id);
    if (!match) throw new NotFoundException("Combat introuvable");
    return toAdminMatchView(match);
  }

  // Prévisualisation : validations + doublons/conflits, AUCUNE écriture.
  async previewCreate(competitionId: string, dto: AdminMatchDto) {
    const competition = await this.competition(competitionId);
    const { data, athletes } = await this.validate(dto);
    return this.previewView(data, athletes, await this.duplicates(competitionId, data), warningsFor(data, competition));
  }

  async create(competitionId: string, dto: AdminMatchDto, adminUserId: string) {
    await this.competition(competitionId);
    const { data } = await this.validate(dto);
    const refs = await this.duplicates(competitionId, data);
    await this.assertWritable(refs, dto.acknowledgedDuplicateIds);
    let created;
    try {
      created = await this.repository.createManual(competitionId, data);
    } catch (error) {
      throw mapCheckViolation(error);
    }
    this.audit.record("admin.match.created", { userId: adminUserId, competitionId, matchId: created.id, acknowledgedIds: refs.map((r) => r.id) });
    return this.get(created.id);
  }

  async previewUpdate(id: string, dto: AdminMatchDto) {
    const current = await this.manualMatch(id);
    const competition = await this.competition(current.competition_id);
    const { data, athletes } = await this.validate(dto);
    return {
      ...(await this.previewView(data, athletes, await this.duplicates(current.competition_id, data, id), warningsFor(data, competition))),
      changedFields: changedFields(current, data),
    };
  }

  async update(id: string, dto: AdminMatchDto, adminUserId: string) {
    const current = await this.manualMatch(id);
    const { data } = await this.validate(dto);
    const fields = changedFields(current, data);
    if (fields.length === 0) return toAdminMatchView(current);
    await this.assertWritable(await this.duplicates(current.competition_id, data, id), dto.acknowledgedDuplicateIds);
    try {
      await this.repository.updateManual(id, data);
    } catch (error) {
      if (error instanceof MatchNoLongerManualError) throw new ForbiddenException(IMPORTED_MATCH_MESSAGE);
      throw mapCheckViolation(error);
    }
    this.audit.record("admin.match.updated", { userId: adminUserId, matchId: id, fields });
    return this.get(id);
  }

  private async manualMatch(id: string): Promise<MatchWithRelations> {
    const match = await this.repository.findById(id);
    if (!match) throw new NotFoundException("Combat introuvable");
    if (matchOrigin(match.sources) !== "manual") throw new ForbiddenException(IMPORTED_MATCH_MESSAGE);
    return match;
  }

  private async competition(competitionId: string) {
    const competition = await this.repository.competition(competitionId);
    if (!competition) throw new NotFoundException("Compétition introuvable");
    return competition;
  }

  // Règles métier : deux athlètes distincts et existants (external_athlete),
  // vainqueur = l'un des deux (par construction), scores entiers >= 0 (DTO),
  // date réelle. Rien n'est déduit : vainqueur, méthode, tour, n° et date
  // inconnus restent NULL.
  private async validate(dto: AdminMatchDto) {
    if (dto.athleteAId === dto.athleteBId) throw new BadRequestException(SAME_ATHLETE_MESSAGE);
    const athletes = await this.repository.athletes([dto.athleteAId, dto.athleteBId]);
    const missing = [dto.athleteAId, dto.athleteBId].filter((id) => !athletes.some((a) => a.id === id));
    if (missing.length > 0) throw new BadRequestException("Athlète international introuvable : sélectionnez un athlète existant");

    let occurredAt: Date | null = null;
    if (dto.occurredOn) {
      occurredAt = new Date(`${dto.occurredOn}T00:00:00.000Z`);
      if (Number.isNaN(occurredAt.getTime()) || occurredAt.toISOString().slice(0, 10) !== dto.occurredOn) {
        throw new BadRequestException("La date du combat n'est pas une date valide");
      }
    }
    const data: MatchData = {
      category_label: dto.category,
      bracket_stage: dto.bracketStage ?? null,
      contest_number: dto.contestNumber ?? null,
      athlete_a_id: dto.athleteAId,
      athlete_b_id: dto.athleteBId,
      score_a: dto.scoreA ?? null,
      score_b: dto.scoreB ?? null,
      winner_athlete_id: dto.winner === "A" ? dto.athleteAId : dto.winner === "B" ? dto.athleteBId : null,
      result_method: dto.resultMethod ?? null,
      occurred_at: occurredAt,
    };
    return { data, athletes };
  }

  private async duplicates(competitionId: string, data: MatchData, excludeId?: string): Promise<MatchCandidateRef[]> {
    const [sameKey, samePair] = await Promise.all([
      this.repository.findSameKey(competitionId, data, excludeId),
      this.repository.findSamePair(competitionId, data, excludeId),
    ]);
    return analyseMatchDuplicates(toFacts(data), sameKey.map(fromRow), samePair.map(fromRow));
  }

  // "identical" n'est jamais confirmable ; "conflict"/"possible" exigent une
  // confirmation explicite. 409 avec les deux versions dans tous les cas.
  private async assertWritable(refs: MatchCandidateRef[], acknowledged: string[] | undefined) {
    if (refs.length === 0) return;
    const candidates = await this.candidateViews(refs);
    if (refs.some((r) => r.level === "identical")) {
      throw new ConflictException({ statusCode: 409, message: MATCH_EXISTS_MESSAGE, blocking: true, candidates });
    }
    const ack = new Set(acknowledged ?? []);
    if (refs.some((r) => !ack.has(r.id))) throw new ConflictException({ statusCode: 409, message: MATCH_DUPLICATES_MESSAGE, candidates });
  }

  private async candidateViews(refs: MatchCandidateRef[]) {
    const matches = await this.repository.findManyById(refs.map((r) => r.id));
    const byId = new Map(matches.map((m) => [m.id, m]));
    return refs
      .filter((r) => byId.has(r.id))
      .map((r) => ({ level: r.level, differences: r.differences, match: toAdminMatchView(byId.get(r.id)!) }));
  }

  private async previewView(
    data: MatchData,
    athletes: { id: string; display_name: string; country_code: string | null }[],
    refs: MatchCandidateRef[],
    warnings: string[],
  ) {
    const athlete = (id: string) => {
      const a = athletes.find((x) => x.id === id)!;
      return { id: a.id, displayName: a.display_name, countryCode: a.country_code };
    };
    const candidates = await this.candidateViews(refs);
    return {
      data: {
        category: data.category_label,
        stage: data.bracket_stage,
        contestNumber: data.contest_number,
        athleteA: athlete(data.athlete_a_id),
        athleteB: athlete(data.athlete_b_id),
        scoreA: data.score_a,
        scoreB: data.score_b,
        winnerSide: data.winner_athlete_id === null ? null : data.winner_athlete_id === data.athlete_a_id ? "A" : "B",
        method: data.result_method,
        occurredOn: data.occurred_at ? data.occurred_at.toISOString().slice(0, 10) : null,
      },
      blocking: refs.some((r) => r.level === "identical") ? MATCH_EXISTS_MESSAGE : null,
      candidates,
      warnings,
    };
  }
}

function toFacts(data: MatchData) {
  return {
    athleteAId: data.athlete_a_id,
    athleteBId: data.athlete_b_id,
    scoreA: data.score_a,
    scoreB: data.score_b,
    winnerAthleteId: data.winner_athlete_id,
    resultMethod: data.result_method,
    bracketStage: data.bracket_stage,
  };
}

function fromRow(row: {
  id: string;
  athlete_a_id: string;
  athlete_b_id: string;
  score_a: number | null;
  score_b: number | null;
  winner_athlete_id: string | null;
  result_method: string | null;
  bracket_stage: string | null;
}) {
  return {
    id: row.id,
    athleteAId: row.athlete_a_id,
    athleteBId: row.athlete_b_id,
    scoreA: row.score_a,
    scoreB: row.score_b,
    winnerAthleteId: row.winner_athlete_id,
    resultMethod: row.result_method,
    bracketStage: row.bracket_stage,
  };
}

// Jamais de correction : uniquement des signalements.
function warningsFor(data: MatchData, competition: { date_debut: Date; date_fin: Date | null }): string[] {
  const warnings: string[] = [];
  if (data.contest_number === null) {
    warnings.push("Sans numéro de combat, ce combat ne pourra pas être rapproché d'un import WT ultérieur (risque de doublon).");
  }
  if (data.bracket_stage === null) warnings.push("Tour du tableau non renseigné.");
  const hasScores = data.score_a !== null || data.score_b !== null;
  if (data.winner_athlete_id === null && hasScores) {
    warnings.push("Scores renseignés sans vainqueur : le vainqueur n'est jamais déduit du score.");
  }
  if (data.winner_athlete_id !== null && data.score_a !== null && data.score_b !== null) {
    const winnerIsA = data.winner_athlete_id === data.athlete_a_id;
    const [winnerScore, loserScore] = winnerIsA ? [data.score_a, data.score_b] : [data.score_b, data.score_a];
    if (winnerScore <= loserScore) {
      warnings.push("Le vainqueur n'a pas le score le plus élevé : vérifiez la méthode (RSC, DSQ, WDR...).");
    }
  }
  if (data.occurred_at) {
    const end = competition.date_fin ?? competition.date_debut;
    if (data.occurred_at < competition.date_debut || data.occurred_at > end) {
      warnings.push("La date du combat est en dehors des dates de la compétition.");
    }
  }
  return warnings;
}

const COMPARED: (keyof MatchData)[] = [
  "category_label",
  "bracket_stage",
  "contest_number",
  "athlete_a_id",
  "athlete_b_id",
  "score_a",
  "score_b",
  "winner_athlete_id",
  "result_method",
  "occurred_at",
];

function changedFields(current: MatchWithRelations, next: MatchData): string[] {
  return COMPARED.filter((field) => {
    const before = current[field] as unknown;
    const after = next[field] as unknown;
    if (before instanceof Date || after instanceof Date) {
      return !(before instanceof Date && after instanceof Date && before.getTime() === after.getTime());
    }
    return before !== after;
  });
}

// Filet : contraintes CHECK de la migration (A <> B, vainqueur ∈ {A, B}).
function mapCheckViolation(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Prisma.PrismaClientUnknownRequestError) {
    if (/distinct_athletes_check/.test(error.message)) return new BadRequestException(SAME_ATHLETE_MESSAGE);
    if (/winner_is_participant_check/.test(error.message)) return new BadRequestException("Le vainqueur doit être l'un des deux combattants");
  }
  return error;
}

export function toAdminMatchView(match: MatchWithRelations) {
  const origin = matchOrigin(match.sources);
  return {
    ...toResultFightView(match),
    competitionId: match.competition_id,
    occurredOn: match.occurred_at ? match.occurred_at.toISOString().slice(0, 10) : null,
    origin,
    editable: origin === "manual",
  };
}
