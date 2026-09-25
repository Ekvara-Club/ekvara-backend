import { Injectable, NotFoundException } from "@nestjs/common";
import { external_athlete as ExternalAthleteModel } from "../../generated/prisma/client";
import {
  AthleteFightCounts,
  AthleteSearchRow,
  AthleteSearchSort,
  AthleteWithSources,
  InternationalRepository,
  MatchWithRelations,
} from "./international.repository";

@Injectable()
export class InternationalService {
  constructor(private readonly repository: InternationalRepository) {}

  async searchAthletes(search: string | undefined, page: number, limit: number, sort: AthleteSearchSort = "name") {
    const result = await this.repository.searchAthletes(search, page, limit, sort);
    return { ...result, items: result.items.map(toAthleteSearchItem) };
  }

  async getAthlete(id: string) {
    const athlete = await this.repository.findAthleteById(id);
    if (!athlete) {
      throw new NotFoundException(`Athlète international ${id} introuvable`);
    }
    const view = toAthleteView(athlete);
    const counts = await this.repository.countAthleteFights(id);
    return { ...view, stats: { ...view.stats, recorded: toRecordedStats(counts) } };
  }

  async getAthleteMatches(id: string, page: number, limit: number) {
    if (!(await this.repository.findAthleteById(id))) {
      throw new NotFoundException(`Athlète international ${id} introuvable`);
    }
    const result = await this.repository.findMatchesByAthlete(id, page, limit);
    // Vue A/B historique inchangée + perspective de l'athlète demandé (même
    // interprétation que l'historique par compétition : athleteResult()).
    return { ...result, items: result.items.map((m) => ({ ...toMatchView(m), perspective: toAthleteFightView(m, id) })) };
  }

  async getAthleteCompetitions(id: string, page: number, limit: number) {
    if (!(await this.repository.findAthleteById(id))) {
      throw new NotFoundException(`Athlète international ${id} introuvable`);
    }
    const { competitions, matches, total } = await this.repository.findAthleteCompetitionHistory(id, page, limit);
    const items = competitions.map((competition) => {
      const fights = matches
        .filter((m) => m.competition_id === competition.id)
        .map((m) => toAthleteFightView(m, id))
        .sort(compareFightsInBracketOrder);
      const count = (outcome: AthleteOutcome) => fights.filter((f) => f.result.outcome === outcome).length;
      return {
        competition: toCompetitionRef(competition),
        // Catégories réellement présentes dans les combats (un athlète peut
        // en disputer plusieurs à la même compétition) — jamais déduites.
        categories: [...new Set(fights.map((f) => f.category).filter((c): c is string => c !== null))],
        fights: fights.length,
        wins: count("WIN"),
        losses: count("LOSS"),
        unknown: count("UNKNOWN"),
        matches: fights,
      };
    });
    return { items, total, page, limit };
  }

  // Résumé des résultats d'une compétition canonique : totaux + catégories
  // ordonnées — jamais la liste des combats (voir getCompetitionCategoryResults).
  async getCompetitionResultsSummary(competitionId: string) {
    await this.assertCompetitionExists(competitionId);
    const summary = await this.repository.summarizeCompetitionResults(competitionId);
    return {
      competitionId,
      matchCount: summary.fights,
      athleteCount: summary.athletes,
      categories: summary.categories
        .filter((c): c is { category_label: string; fights: number; athletes: number } => c.category_label !== null)
        .map((c) => ({ label: c.category_label, fightCount: c.fights, athleteCount: c.athletes }))
        .sort((a, b) => compareCategoryLabels(a.label, b.label)),
    };
  }

  // Combats d'UNE catégorie (label stocké exact) groupés par tour, dans
  // l'ordre du tableau (R32 → F), tour inconnu en dernier.
  async getCompetitionCategoryResults(competitionId: string, category: string) {
    await this.assertCompetitionExists(competitionId);
    const matches = await this.repository.findCompetitionCategoryMatches(competitionId, category);
    if (matches.length === 0) {
      throw new NotFoundException(`Catégorie "${category}" introuvable pour la competition ${competitionId}`);
    }
    const fights = matches.map(toResultFightView).sort(
      (a, b) =>
        stageRank(a.stage) - stageRank(b.stage) ||
        (a.contestNumber ?? Number.MAX_SAFE_INTEGER) - (b.contestNumber ?? Number.MAX_SAFE_INTEGER) ||
        a.id.localeCompare(b.id),
    );
    const rounds: { stage: string | null; fights: typeof fights }[] = [];
    for (const fight of fights) {
      const last = rounds[rounds.length - 1];
      if (last && last.stage === fight.stage) last.fights.push(fight);
      else rounds.push({ stage: fight.stage, fights: [fight] });
    }
    return { competitionId, category, fightCount: fights.length, rounds };
  }

  private async assertCompetitionExists(competitionId: string) {
    if (!(await this.repository.competitionExists(competitionId))) {
      throw new NotFoundException(`Competition ${competitionId} introuvable`);
    }
  }

  async getCompetitionMatches(competitionId: string, page: number, limit: number) {
    if (!(await this.repository.competitionExists(competitionId))) {
      throw new NotFoundException(`Competition ${competitionId} introuvable`);
    }
    const result = await this.repository.findMatchesByCompetition(competitionId, page, limit);
    return { ...result, items: result.items.map(toMatchView) };
  }
}

// Vue stable : jamais l'objet Prisma brut (created_at/updated_at internes).
//
// stats.sourceRecord : record V/D AFFICHÉ par la source avec sa provenance et sa
// date de relevé — jamais un record recalculé à partir de nos matchs (jeu
// partiel : un faux 3-1 sur 4 combats importés serait trompeur). null tant
// qu'aucun profil source n'a été relevé.
export function toAthleteView(athlete: AthleteWithSources) {
  const withImage = athlete.sources.find((s) => s.image_url !== null);
  const withRecord = athlete.sources.find((s) => s.record_wins !== null && s.record_losses !== null);

  return {
    id: athlete.id,
    displayName: athlete.display_name,
    countryCode: athlete.country_code,
    imageUrl: withImage?.image_url ?? null,
    sources: athlete.sources.map((s) => ({
      source: s.source,
      externalId: s.source_external_id,
      sourceUrl: s.source_url,
    })),
    stats: {
      sourceRecord: withRecord
        ? {
            wins: withRecord.record_wins,
            losses: withRecord.record_losses,
            source: withRecord.source,
            syncedAt: withRecord.record_synced_at,
          }
        : null,
    },
  };
}

function toAthleteSummary(athlete: ExternalAthleteModel) {
  return { id: athlete.id, displayName: athlete.display_name, countryCode: athlete.country_code };
}

// scoreA/scoreB suivent l'ordre athleteA/athleteB tel que lu sur la page match
// de la source ; winner vient du marqueur de la source (jamais scoreA > scoreB).
// stage = tour du tableau (F, SF, QF, R16...), à ne pas confondre avec les
// rounds R1/R2/R3 d'un combat, non exposés en V1.
export function toMatchView(match: MatchWithRelations) {
  return {
    id: match.id,
    competition: toCompetitionRef(match.competition),
    category: match.category_label,
    stage: match.bracket_stage,
    contestNumber: match.contest_number,
    athleteA: toAthleteSummary(match.athlete_a),
    athleteB: toAthleteSummary(match.athlete_b),
    scoreA: match.score_a,
    scoreB: match.score_b,
    winner: match.winner ? toAthleteSummary(match.winner) : null,
    method: match.result_method,
    // Représentation retenue à la création (comportement historique inchangé).
    source: { source: match.source, externalId: match.source_external_id, sourceUrl: match.source_url },
    // TOUTES les représentations source du même combat (WT Results en publie
    // parfois plusieurs pour un combat réel) : provenance complète, jamais
    // dupliquée en autant de combats.
    sources: match.sources.map((s) => ({ source: s.source, externalId: s.source_external_id, sourceUrl: s.source_url })),
  };
}

type CompetitionRow = MatchWithRelations["competition"];

// Compétition CANONIQUE (competition.id = identité de navigation EKVARA).
function toCompetitionRef(competition: CompetitionRow) {
  return {
    id: competition.id,
    name: competition.nom,
    dateDebut: competition.date_debut,
    dateFin: competition.date_fin,
    lieu: competition.lieu,
    ville: competition.ville,
    pays: competition.pays,
  };
}

function toAthleteSearchItem(row: AthleteSearchRow) {
  return {
    id: row.id,
    displayName: row.display_name,
    countryCode: row.country_code,
    sources: row.sources.map((s) => ({ source: s.source, externalId: s.source_external_id, sourceUrl: s.source_url })),
    // Un combat logique a exactement un athlete_a et un athlete_b distincts
    // (CHECK Postgres) : la somme ne compte jamais deux fois le même combat.
    fightCount: row._count.matches_as_a + row._count.matches_as_b,
  };
}

// Bilan calculé sur les combats RECENSÉS dans EKVARA (jeu partiel, distinct
// du record affiché par la source : stats.sourceRecord). winRate = victoires
// / combats au résultat connu, en pourcentage entier ; null sans combat décidé.
export function toRecordedStats(counts: AthleteFightCounts) {
  const decided = counts.wins + counts.losses;
  return { ...counts, winRate: decided > 0 ? Math.round((counts.wins / decided) * 100) : null };
}

export type AthleteOutcome = "WIN" | "LOSS" | "UNKNOWN";

// SEULE interprétation du résultat d'un combat pour un athlète (le frontend
// ne la refait jamais). Le vainqueur enregistré fait foi ; les scores ne
// sont JAMAIS utilisés pour déduire ou corriger le résultat (sources avec
// vainqueur au score inférieur : RSC, WDR, DSQ...). Fail-safe : athlète
// absent du combat, vainqueur absent ou étranger au combat ⇒ UNKNOWN.
export function athleteResult(match: Pick<MatchWithRelations, "athlete_a_id" | "athlete_b_id" | "winner_athlete_id">, athleteId: string): AthleteOutcome {
  if (match.athlete_a_id !== athleteId && match.athlete_b_id !== athleteId) return "UNKNOWN";
  const opponentId = match.athlete_a_id === athleteId ? match.athlete_b_id : match.athlete_a_id;
  if (match.winner_athlete_id === athleteId) return "WIN";
  if (match.winner_athlete_id !== null && match.winner_athlete_id === opponentId) return "LOSS";
  return "UNKNOWN";
}

// Combat vu depuis un athlète : son côté (A/B tel que publié), son
// adversaire, son score et celui de l'adversaire réorientés, sans jamais
// modifier les valeurs sources. Un combat logique = une ligne, quel que soit
// le nombre de ses représentations source (toutes listées dans sources).
export function toAthleteFightView(match: MatchWithRelations, athleteId: string) {
  const side: "A" | "B" = match.athlete_a_id === athleteId ? "A" : "B";
  const opponent = side === "A" ? match.athlete_b : match.athlete_a;
  return {
    id: match.id,
    competitionId: match.competition_id,
    category: match.category_label,
    stage: match.bracket_stage,
    contestNumber: match.contest_number,
    side,
    opponent: toAthleteSummary(opponent),
    result: {
      outcome: athleteResult(match, athleteId),
      athleteScore: side === "A" ? match.score_a : match.score_b,
      opponentScore: side === "A" ? match.score_b : match.score_a,
      method: match.result_method,
    },
    sources: match.sources.map((s) => ({ source: s.source, externalId: s.source_external_id, sourceUrl: s.source_url })),
  };
}

// Ordre de lecture d'un parcours : tours du tableau dans l'ordre réel
// (R128 → F), puis numéro de combat, puis id ; tour inconnu en dernier.
const STAGE_ORDER = ["R128", "R64", "R32", "R16", "QF", "SF", "BMC", "F"];
export function stageRank(stage: string | null): number {
  const index = stage === null ? -1 : STAGE_ORDER.indexOf(stage);
  return index === -1 ? STAGE_ORDER.length : index;
}
function compareFightsInBracketOrder(a: ReturnType<typeof toAthleteFightView>, b: ReturnType<typeof toAthleteFightView>): number {
  return (
    stageRank(a.stage) - stageRank(b.stage) ||
    (a.contestNumber ?? Number.MAX_SAFE_INTEGER) - (b.contestNumber ?? Number.MAX_SAFE_INTEGER) ||
    a.id.localeCompare(b.id)
  );
}

// Côté vainqueur d'un combat, d'après le SEUL vainqueur enregistré (même
// sémantique que athleteResult : jamais les scores). Fail-safe : vainqueur
// absent ou étranger au combat ⇒ null (aucun vainqueur affiché).
export function winnerSide(match: Pick<MatchWithRelations, "athlete_a_id" | "athlete_b_id" | "winner_athlete_id">): "A" | "B" | null {
  if (match.winner_athlete_id === null) return null;
  if (match.winner_athlete_id === match.athlete_a_id) return "A";
  if (match.winner_athlete_id === match.athlete_b_id) return "B";
  return null;
}

// Combat vu depuis la compétition : les deux athlètes dans l'ordre publié
// par la source, scores tels que stockés, vainqueur désigné par winnerSide.
// Un combat logique = une entrée, quel que soit le nombre de représentations.
export function toResultFightView(match: MatchWithRelations) {
  return {
    id: match.id,
    category: match.category_label,
    stage: match.bracket_stage,
    contestNumber: match.contest_number,
    athleteA: toAthleteSummary(match.athlete_a),
    athleteB: toAthleteSummary(match.athlete_b),
    scoreA: match.score_a,
    scoreB: match.score_b,
    winnerSide: winnerSide(match),
    method: match.result_method,
    sources: match.sources.map((s) => ({ source: s.source, externalId: s.source_external_id, sourceUrl: s.source_url })),
  };
}

// Ordre sportif des catégories quand le label le permet SANS interprétation :
// "<Préfixe> -58kg" / "<Préfixe> +80kg" (préfixe tel quel, sensible à la
// casse, jamais fusionné) ⇒ par préfixe, puis poids croissant, "+" après "-"
// au même poids. Tout autre label (ex. ".1 (QF) / Men -80kg") vient ensuite,
// en ordre alphabétique. Ordre total et déterministe.
const WEIGHT_CATEGORY = /^([A-Za-z]+(?: [A-Za-z]+)*) ([+-])(\d+)kg$/;
// Comparaison par code point (jamais localeCompare, dont le résultat dépend
// de la locale ICU de la machine) : même ordre partout.
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
export function compareCategoryLabels(a: string, b: string): number {
  const ma = WEIGHT_CATEGORY.exec(a);
  const mb = WEIGHT_CATEGORY.exec(b);
  if (ma && !mb) return -1;
  if (!ma && mb) return 1;
  if (ma && mb) {
    return (
      byCodePoint(ma[1], mb[1]) ||
      Number(ma[3]) - Number(mb[3]) ||
      (ma[2] === mb[2] ? 0 : ma[2] === "-" ? -1 : 1) ||
      byCodePoint(a, b)
    );
  }
  return byCodePoint(a, b);
}
