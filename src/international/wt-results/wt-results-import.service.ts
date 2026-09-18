import { Injectable, Logger } from "@nestjs/common";
import { AttachOutcome, CompetitionSourceConflictError, InternationalRepository } from "../international.repository";
import { mapResultsCompetition, WtrMappingResult } from "./wtr-competition-matcher";
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
  matchesCreated: number;
  matchesUpdated: number;
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
  matches: { withoutWinner: number; withoutScore: number; sourceDuplicates: number };
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
      matches: { withoutWinner: 0, withoutScore: 0, sourceDuplicates: 0 },
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
    report.matches.sourceDuplicates = tracker.sourceDuplicates;
    return report;
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
    const candidates = await this.repository.findCalendarCandidates(item.dateStart);
    const mapping = mapResultsCompetition(item, candidates, list);
    const target = candidates.find((c) => c.competitionId === mapping.competitionId);
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
      else result.matchesUpdated++;
    }

    return;
  }

  private async persistMatch(
    competitionId: string,
    slug: string,
    match: WtrMatch,
    tracker: RunTracker,
    report: PilotImportReport,
  ): Promise<"created" | "updated"> {
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

    // Doublons CÔTÉ SOURCE (constat réel : Muju répète des combats identiques
    // avec des identifiants de match distincts) : jamais fusionnés — l'identité
    // reste l'id de match source — mais rapportés.
    const fingerprint = [slug, match.categoryLabel, match.bracketStage, [a.sourceId, b.sourceId].sort().join("+"), match.scoreA, match.scoreB, match.resultMethod].join("|");
    const previous = tracker.fingerprints.get(fingerprint);
    if (previous && previous !== match.sourceMatchId) {
      tracker.sourceDuplicates++;
      report.anomalies.push(
        `[${slug}] match ${match.sourceMatchId}: mêmes athlètes/stade/score/méthode que ${previous} avec un identifiant source distinct — conservé tel quel (doublon côté source probable)`,
      );
    } else {
      tracker.fingerprints.set(fingerprint, match.sourceMatchId);
    }

    const saved = await this.repository.upsertMatch({
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
    return saved.created ? "created" : "updated";
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
    matchesUpdated: 0,
    matchesSkippedExisting: 0,
    matchesFailed: [],
    notes: [],
  };
}

class RunTracker {
  appearances = 0;
  created = 0;
  sourceDuplicates = 0;
  withoutWinner = 0;
  withoutScore = 0;
  readonly uniqueAthletes = new Set<string>();
  readonly withoutNoc = new Set<string>();
  readonly fingerprints = new Map<string, string>();
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
