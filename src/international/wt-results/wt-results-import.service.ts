import { Injectable, Logger } from "@nestjs/common";
import { AttachOutcome, CompetitionSourceConflictError, InternationalRepository, MatchSaveOutcome } from "../international.repository";
import {
  mapResultsCompetition,
  mapResultsCompetitionByDivisions,
  normalizeCompetitionName,
  resultsDisciplineFromCategories,
  WtrCompetitionRef,
  WtrMappingResult,
} from "./wtr-competition-matcher";
import { WorldTaekwondoResultsImporterService, WtrBlockedError, WtrHttpError } from "./wt-results-importer.service";
import { competitionResultsUrl, matchUrl, profileUrl, WT_RESULTS_SOURCE, WtrMatch } from "./wtr-parser";

// Orchestration du POC "WT Results Data Foundation V1" : rattachement SÛR d'une
// compétition Results à une competition canonique existante, puis import des
// matchs depuis les PAGES MATCH (seule source où l'ordre A/B, les scores et le
// vainqueur sont explicitement observables).
//
// Garde-fous volontaires — ce n'est PAS un backfill :
//   - au plus MAX_PILOT_COMPETITIONS compétitions par exécution ;
//   - une catégorie de poids optionnelle (filtre natif ?event= du site) ;
//   - plafond de matchs par compétition (DEFAULT_MAX_MATCHES) ;
//   - les matchs déjà en base ne sont pas re-téléchargés (refreshExisting=false) ;
//   - arrêt net au premier signal de blocage de la source.

export const MAX_PILOT_COMPETITIONS = 3;
export const MAX_PILOT_PROFILES = 10;
const DEFAULT_MAX_MATCHES = 200;
const MAX_CONSECUTIVE_FETCH_FAILURES = 3;

export interface PilotImportOptions {
  year: number;
  slugs: string[];
  // Libellé exact d'une catégorie du site (ex. "Men -68kg"). Absent = toute la
  // compétition (à réserver aux petites compétitions, voir plafond).
  categoryLabel?: string;
  maxMatchesPerCompetition?: number;
  refreshExisting?: boolean;
  // Calcule et rapporte le mapping calendrier ↔ Results (1 requête : la liste
  // de l'année) SANS RIEN ÉCRIRE : point de contrôle avant toute écriture.
  mappingOnly?: boolean;
  // UUID WT Results d'athlètes DÉJÀ importés dont on veut relever le record V/D
  // affiché (une requête profil chacun).
  profileAthleteIds?: string[];
}

export interface CompetitionImportReport {
  slug: string;
  resultsName: string | null;
  resultsDates: { start: string; end: string } | null;
  mapping: (WtrMappingResult & { ekvaraName: string | null; calendarExternalIds: string[] }) | null;
  attach: AttachOutcome | null;
  category: string | null;
  matchesListed: number;
  matchesCapped: number;
  matchesFetched: number;
  // Nouveaux combats LOGIQUES créés (aucun combat existant partageant la clé).
  matchesCreated: number;
  // SAME_LOGICAL_FIGHT : identifiant source rattaché à un combat existant.
  matchesAttached: number;
  // Représentations déjà connues, revues (refresh).
  matchesUpdated: number;
  // CONFLICT / AMBIGUOUS : clé partagée mais non fusionné, données conservées.
  matchesConflicts: number;
  matchesSkippedExisting: number;
  matchesFailed: { matchId: string; reason: string }[];
  notes: string[];
}

export interface PilotImportReport {
  pagesFetched: number;
  aborted: string | null;
  competitions: CompetitionImportReport[];
  athletes: {
    appearances: number;
    unique: number;
    created: number;
    reusedExisting: number;
    withoutNoc: number;
  };
  matches: { withoutWinner: number; withoutScore: number; sameLogicalFight: number; conflicts: number; ambiguous: number };
  anomalies: string[];
  profiles: { requested: number; updated: number; failed: { athleteId: string; reason: string }[] };
}

@Injectable()
export class WtResultsImportService {
  private readonly logger = new Logger(WtResultsImportService.name);

  constructor(
    private readonly importer: WorldTaekwondoResultsImporterService,
    private readonly repository: InternationalRepository,
  ) {}

  async runPilot(options: PilotImportOptions): Promise<PilotImportReport> {
    if (options.slugs.length === 0 || options.slugs.length > MAX_PILOT_COMPETITIONS) {
      throw new Error(`Le POC importe entre 1 et ${MAX_PILOT_COMPETITIONS} compétitions (${options.slugs.length} demandée(s)).`);
    }
    if ((options.profileAthleteIds?.length ?? 0) > MAX_PILOT_PROFILES) {
      throw new Error(`Au plus ${MAX_PILOT_PROFILES} profils peuvent être relevés pendant le POC.`);
    }

    const pagesBefore = this.importer.getPagesFetched();
    const tracker = new RunTracker();
    const report: PilotImportReport = {
      pagesFetched: 0,
      aborted: null,
      competitions: [],
      athletes: { appearances: 0, unique: 0, created: 0, reusedExisting: 0, withoutNoc: 0 },
      matches: { withoutWinner: 0, withoutScore: 0, sameLogicalFight: 0, conflicts: 0, ambiguous: 0 },
      anomalies: [],
      profiles: { requested: options.profileAthleteIds?.length ?? 0, updated: 0, failed: [] },
    };

    try {
      const list = await this.importer.fetchCompetitionList(options.year);

      for (const slug of options.slugs) {
        // Enregistré AVANT l'import : un arrêt sur blocage garde les compteurs partiels.
        const competitionReport = newCompetitionReport(slug, options);
        report.competitions.push(competitionReport);
        await this.importCompetition(competitionReport, list, options, tracker, report);
      }

      for (const athleteId of options.profileAthleteIds ?? []) {
        await this.enrichProfile(athleteId, report);
      }
    } catch (error) {
      if (error instanceof WtrBlockedError) {
        report.aborted = error.message;
        this.logger.error(error.message);
      } else {
        throw error;
      }
    }

    report.pagesFetched = this.importer.getPagesFetched() - pagesBefore;
    report.athletes.appearances = tracker.appearances;
    report.athletes.unique = tracker.uniqueAthletes.size;
    report.athletes.created = tracker.created;
    report.athletes.reusedExisting = tracker.appearances - tracker.created;
    report.athletes.withoutNoc = tracker.withoutNoc.size;
    report.matches.withoutWinner = tracker.withoutWinner;
    report.matches.withoutScore = tracker.withoutScore;
    report.matches.sameLogicalFight = tracker.sameLogicalFight;
    report.matches.conflicts = tracker.conflicts;
    report.matches.ambiguous = tracker.ambiguous;
    return report;
  }

  // Mapping d'UN événement Results, partagé par l'import et la discovery du
  // backfill (même verdict aux deux étapes) : règle exacte d'abord, inchangée ;
  // seulement si elle répond UNMATCHED, règle par divisions calendrier (#22).
  // Les catégories Results (1 requête) ne sont lues que s'il existe au moins
  // une candidate homonyme dont la plage contient l'événement.
  async resolveMapping(
    item: WtrCompetitionRef,
    list: WtrCompetitionRef[],
  ): Promise<{ mapping: WtrMappingResult; target: { nom: string; calendarExternalIds: string[] } | null }> {
    const exactCandidates = await this.repository.findCalendarCandidates(item.dateStart);
    const exact = mapResultsCompetition(item, exactCandidates, list);
    if (exact.verdict !== "UNMATCHED") {
      return { mapping: exact, target: exactCandidates.find((c) => c.competitionId === exact.competitionId) ?? null };
    }

    const name = normalizeCompetitionName(item.name);
    const divisionCandidates = (await this.repository.findDivisionCandidates(item.dateStart, item.dateEnd)).filter(
      (c) => normalizeCompetitionName(c.nom) === name,
    );
    if (divisionCandidates.length === 0) return { mapping: exact, target: null };

    const listing = await this.importer.fetchResultsListing(item.slug);
    const discipline = resultsDisciplineFromCategories(listing.categories.map((c) => c.label));
    const byDivisions = mapResultsCompetitionByDivisions(item, divisionCandidates, list, discipline);
    if (byDivisions.verdict === "UNMATCHED") {
      return { mapping: { ...exact, reasons: [...exact.reasons, ...byDivisions.reasons] }, target: null };
    }
    return {
      mapping: byDivisions,
      target: divisionCandidates.find((c) => c.competitionId === byDivisions.competitionId) ?? null,
    };
  }

  private async importCompetition(
    result: CompetitionImportReport,
    list: Awaited<ReturnType<WorldTaekwondoResultsImporterService["fetchCompetitionList"]>>,
    options: PilotImportOptions,
    tracker: RunTracker,
    report: PilotImportReport,
  ): Promise<void> {
    const slug = result.slug;
    const item = list.find((c) => c.slug === slug);
    if (!item) {
      result.notes.push(`slug absent de la liste Results ${options.year} — rien importé`);
      return;
    }
    result.resultsName = item.name;
    result.resultsDates = { start: isoDay(item.dateStart), end: isoDay(item.dateEnd) };

    // 1) Mapping conservateur calendrier WT ↔ Results (voir wtr-competition-matcher).
    const { mapping, target } = await this.resolveMapping(item, list);
    result.mapping = {
      ...mapping,
      ekvaraName: target?.nom ?? null,
      calendarExternalIds: target?.calendarExternalIds ?? [],
    };

    if (options.mappingOnly) {
      result.notes.push("mapping seul : aucune donnée écrite");
      return;
    }

    if (mapping.verdict !== "SAFE" || !mapping.competitionId) {
      result.notes.push(`mapping ${mapping.verdict} — aucune donnée écrite pour cette compétition`);
      return;
    }

    // 2) Attache la source Results à la competition CANONIQUE (jamais de création).
    try {
      result.attach = await this.repository.attachResultsSource({
        competitionId: mapping.competitionId,
        source: WT_RESULTS_SOURCE,
        sourceExternalId: slug,
        sourceUrl: competitionResultsUrl(slug),
        rawName: item.name,
      });
    } catch (error) {
      if (error instanceof CompetitionSourceConflictError) {
        result.notes.push(error.message);
        return;
      }
      throw error;
    }

    // 3) Liste des matchs (éventuellement filtrée par catégorie).
    let eventId: string | undefined;
    if (options.categoryLabel) {
      const full = await this.importer.fetchResultsListing(slug);
      const category = full.categories.find((c) => c.label.toLowerCase() === options.categoryLabel!.toLowerCase());
      if (!category) {
        result.notes.push(
          `catégorie "${options.categoryLabel}" introuvable (disponibles : ${full.categories.map((c) => c.label).join(", ") || "aucune"})`,
        );
        return;
      }
      eventId = category.eventId;
    }
    const listing = await this.importer.fetchResultsListing(slug, eventId);
    result.matchesListed = listing.matchIds.length;

    const cap = options.maxMatchesPerCompetition ?? DEFAULT_MAX_MATCHES;
    const matchIds = listing.matchIds.slice(0, cap);
    result.matchesCapped = listing.matchIds.length - matchIds.length;
    if (result.matchesCapped > 0) {
      result.notes.push(`plafond de ${cap} matchs atteint : ${result.matchesCapped} match(s) non importé(s)`);
    }

    const existing = options.refreshExisting
      ? new Set<string>()
      : await this.repository.findExistingMatchIds(WT_RESULTS_SOURCE, matchIds);

    // 4) Une page match par match : vérité pour athlètes, orientation, score, vainqueur.
    let consecutiveFailures = 0;
    for (const matchId of matchIds) {
      if (existing.has(matchId)) {
        result.matchesSkippedExisting++;
        continue;
      }

      let parsed;
      try {
        parsed = await this.importer.fetchMatch(slug, matchId);
        consecutiveFailures = 0;
      } catch (error) {
        if (error instanceof WtrBlockedError) throw error;
        result.matchesFailed.push({ matchId, reason: (error as Error).message });
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FETCH_FAILURES) {
          throw new WtrBlockedError(
            `${MAX_CONSECUTIVE_FETCH_FAILURES} échecs de récupération consécutifs (${(error as Error).message}) — import interrompu par prudence`,
          );
        }
        continue;
      }
      result.matchesFetched++;

      if (!parsed.ok) {
        result.matchesFailed.push({ matchId, reason: parsed.reason });
        continue;
      }

      for (const anomaly of parsed.anomalies) {
        report.anomalies.push(`[${slug}] match ${matchId}: ${anomaly}`);
      }

      const outcome = await this.persistMatch(mapping.competitionId, slug, parsed.match, tracker, report);
      if (outcome === "created") result.matchesCreated++;
      else if (outcome === "attached") result.matchesAttached++;
      else if (outcome === "refreshed") result.matchesUpdated++;
      else result.matchesConflicts++;
    }

    return;
  }

  private async persistMatch(
    competitionId: string,
    slug: string,
    match: WtrMatch,
    tracker: RunTracker,
    report: PilotImportReport,
  ): Promise<MatchSaveOutcome> {
    const [a, b] = [match.athleteA, match.athleteB];
    const resolved: string[] = [];
    for (const athlete of [a, b]) {
      const upserted = await this.repository.upsertAthleteFromSource({
        source: WT_RESULTS_SOURCE,
        sourceExternalId: athlete.sourceId,
        sourceUrl: profileUrl(athlete.sourceId),
        displayName: athlete.name,
        countryCode: athlete.countryCode,
        imageUrl: athlete.imageUrl,
      });
      tracker.appearances++;
      tracker.uniqueAthletes.add(athlete.sourceId);
      if (upserted.created) tracker.created++;
      if (!athlete.countryCode) tracker.withoutNoc.add(athlete.sourceId);
      resolved.push(upserted.athleteId);
    }
    const [athleteAId, athleteBId] = resolved;

    const winnerAthleteId = match.winner === "A" ? athleteAId : match.winner === "B" ? athleteBId : null;
    if (match.winner === null) tracker.withoutWinner++;
    if (match.scoreA === null || match.scoreB === null) tracker.withoutScore++;

    // Doublons CÔTÉ SOURCE (constat réel : Muju publie chaque combat sous 4
    // identifiants de match distincts, pages identiques). Rapprochement
    // CONSERVATEUR fait par le repository : clé (compétition, catégorie, n° de
    // combat, paire non ordonnée) puis contrôle attribut par attribut. Tout
    // identifiant source est conservé ; en cas de conflit rien n'est fusionné.
    const saved = await this.repository.saveMatchRepresentation({
      competitionId,
      source: WT_RESULTS_SOURCE,
      sourceExternalId: match.sourceMatchId,
      sourceUrl: matchUrl(slug, match.sourceMatchId),
      categoryLabel: match.categoryLabel,
      bracketStage: match.bracketStage,
      contestNumber: match.contestNumber,
      athleteAId,
      athleteBId,
      scoreA: match.scoreA,
      scoreB: match.scoreB,
      winnerAthleteId,
      resultMethod: match.resultMethod,
      resultMethodRaw: match.resultMethodRaw,
    });

    switch (saved.outcome) {
      case "attached":
        tracker.sameLogicalFight++;
        break;
      case "conflict":
        tracker.conflicts++;
        report.anomalies.push(
          `[${slug}] CONFLICT match ${match.sourceMatchId}: même clé (catégorie, n° de combat, paire d'athlètes) que le combat ${saved.relatedMatchIds.join(", ")} mais ${saved.differences.join(", ")} diverge(nt) — NON fusionné, données conservées`,
        );
        break;
      case "ambiguous":
        tracker.ambiguous++;
        report.anomalies.push(
          `[${slug}] AMBIGUOUS match ${match.sourceMatchId}: cohérent avec plusieurs combats existants (${saved.relatedMatchIds.join(", ")}) — aucun choix arbitraire, représentation conservée séparément`,
        );
        break;
      default:
        break;
    }
    return saved.outcome;
  }

  private async enrichProfile(athleteId: string, report: PilotImportReport): Promise<void> {
    try {
      const parsed = await this.importer.fetchProfile(athleteId);
      if (!parsed.ok) {
        report.profiles.failed.push({ athleteId, reason: parsed.reason });
        return;
      }
      for (const anomaly of parsed.anomalies) report.anomalies.push(`[profil ${athleteId}] ${anomaly}`);

      const saved = await this.repository.saveRecordSnapshot(WT_RESULTS_SOURCE, athleteId, {
        recordWins: parsed.profile.recordWins,
        recordLosses: parsed.profile.recordLosses,
        syncedAt: new Date(),
      });
      if (saved) report.profiles.updated++;
      else report.profiles.failed.push({ athleteId, reason: "athlète inconnu en base (profil jamais créé à partir d'une simple page profil)" });
    } catch (error) {
      if (error instanceof WtrBlockedError) throw error;
      if (error instanceof WtrHttpError) {
        report.profiles.failed.push({ athleteId, reason: error.message });
        return;
      }
      throw error;
    }
  }
}

function newCompetitionReport(slug: string, options: PilotImportOptions): CompetitionImportReport {
  return {
    slug,
    resultsName: null,
    resultsDates: null,
    mapping: null,
    attach: null,
    category: options.categoryLabel ?? null,
    matchesListed: 0,
    matchesCapped: 0,
    matchesFetched: 0,
    matchesCreated: 0,
    matchesAttached: 0,
    matchesUpdated: 0,
    matchesConflicts: 0,
    matchesSkippedExisting: 0,
    matchesFailed: [],
    notes: [],
  };
}

class RunTracker {
  appearances = 0;
  created = 0;
  sameLogicalFight = 0;
  conflicts = 0;
  ambiguous = 0;
  withoutWinner = 0;
  withoutScore = 0;
  readonly uniqueAthletes = new Set<string>();
  readonly withoutNoc = new Set<string>();
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
