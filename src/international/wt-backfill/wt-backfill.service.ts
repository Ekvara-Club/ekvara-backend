import { Injectable, Logger } from "@nestjs/common";
import { InternationalRepository } from "../international.repository";
import { WtrCompetitionRef } from "../wt-results/wtr-competition-matcher";
import { WorldTaekwondoResultsImporterService, WtrBlockedError } from "../wt-results/wt-results-importer.service";
import { WtResultsImportService } from "../wt-results/wt-results-import.service";
import { EventProgress, NewBackfillEvent, WtBackfillRepository } from "./wt-backfill.repository";
import { initialEventStatus, runStatusAfterEventOutcome, WtBackfillEventStatus, WtBackfillRunStatus } from "./wt-backfill-state";
import { withRunLock } from "./wt-backfill-lock";

// Scope obligatoire : jamais de "tout l'historique" par défaut (ticket §Discovery).
export type WtBackfillScope =
  | { kind: "year"; year: number }
  | { kind: "range"; from: string; to: string } // YYYY-MM-DD inclusifs
  | { kind: "slugs"; years: number[]; slugs: string[] }; // years = où chercher ces slugs

export interface DiscoveredEventPreview {
  slug: string;
  name: string;
  dateStart: string;
  dateEnd: string;
  mappingVerdict: "SAFE" | "AMBIGUOUS" | "UNMATCHED";
  competitionId: string | null;
  alreadyImported: boolean;
}

export interface DiscoverResult {
  runId: string;
  scope: WtBackfillScope;
  events: DiscoveredEventPreview[];
}

const emptyProgress = (): EventProgress => ({
  categoriesProcessed: [],
  matchesListed: 0,
  matchesCreated: 0,
  matchesAttached: 0,
  matchesRefreshed: 0,
  matchesSkippedExisting: 0,
  conflicts: 0,
  ambiguous: 0,
  parseFailures: 0,
  athletesCreated: 0,
  athletesReused: 0,
  pagesFetched: 0,
  durationMs: 0,
});

// Orchestrateur #12E. N'IMPORTE RIEN lui-même — délègue systématiquement à
// WtResultsImportService.runPilot() (pipeline #12B/C/D inchangé) et au
// canonical matcher pur (wtr-competition-matcher, inchangé). Voir
// ~/ekvara-checkpoints/12E/audit/PHASE0_AUDIT.md pour la justification de
// chaque choix ci-dessous.
@Injectable()
export class WtBackfillService {
  private readonly logger = new Logger(WtBackfillService.name);

  constructor(
    private readonly repo: WtBackfillRepository,
    private readonly internationalRepo: InternationalRepository,
    private readonly importer: WorldTaekwondoResultsImporterService,
    private readonly importService: WtResultsImportService,
  ) {}

  // --- DISCOVERY (toujours "dry-run" : jamais de competition_match / ------
  // external_athlete écrits ici — seulement la queue de suivi #12E) --------
  async discover(scope: WtBackfillScope): Promise<DiscoverResult> {
    const years = this.yearsForScope(scope);
    if (years.length === 0) {
      throw new Error("Scope invalide : aucune année dérivable (scope obligatoire, aucun backfill total implicite)");
    }

    const listsByYear = new Map<number, Awaited<ReturnType<WorldTaekwondoResultsImporterService["fetchCompetitionList"]>>>();
    for (const year of years) {
      listsByYear.set(year, await this.importer.fetchCompetitionList(year));
    }
    const allItems = [...listsByYear.values()].flat();

    const candidates = this.filterByScope(scope, allItems);
    // Ordre déterministe : date ASC puis slug ASC — jamais l'ordre HTML brut.
    candidates.sort((a, b) => (a.dateStart.getTime() - b.dateStart.getTime()) || a.slug.localeCompare(b.slug));

    const alreadyAttached = await this.repo.findAlreadyAttachedSlugs(candidates.map((c) => c.slug));

    const events: NewBackfillEvent[] = [];
    const preview: DiscoveredEventPreview[] = [];
    for (const item of candidates) {
      const { mapping } = await this.importService.resolveMapping(item, allItems);
      const verdict = mapping.verdict;
      events.push({
        slug: item.slug,
        eventName: item.name,
        dateStart: item.dateStart,
        dateEnd: item.dateEnd,
        mappingVerdict: verdict,
        competitionId: verdict === "SAFE" ? mapping.competitionId : null,
        status: initialEventStatus(verdict),
      });
      preview.push({
        slug: item.slug,
        name: item.name,
        dateStart: isoDay(item.dateStart),
        dateEnd: isoDay(item.dateEnd),
        mappingVerdict: verdict,
        competitionId: verdict === "SAFE" ? mapping.competitionId : null,
        alreadyImported: alreadyAttached.has(item.slug),
      });
    }

    const run = await this.repo.createRunWithEvents(scope, events);
    return { runId: run.id, scope, events: preview };
  }

  // --- START / RESUME (même boucle ; start exige PENDING, resume accepte --
  // RUNNING/BLOCKED/FAILED) -------------------------------------------------
  async start(runId: string, shouldStop: () => boolean = () => false) {
    const run = await this.repo.getRun(runId);
    if (!run) throw new Error(`Run ${runId} introuvable`);
    const status = run.status as WtBackfillRunStatus;
    if (status !== "PENDING") {
      throw new Error(`start refuse un run ${status} (utiliser resume pour reprendre)`);
    }
    await this.repo.setRunStatus(runId, "PENDING", "RUNNING");
    return this.processQueue(runId, shouldStop);
  }

  async resume(runId: string, shouldStop: () => boolean = () => false) {
    const run = await this.repo.getRun(runId);
    if (!run) throw new Error(`Run ${runId} introuvable`);
    const status = run.status as WtBackfillRunStatus;
    if (status === "COMPLETED") throw new Error(`Run ${runId} déjà COMPLETED, rien à reprendre`);
    if (status === "BLOCKED" || status === "FAILED") {
      await this.repo.setRunStatus(runId, status, "RUNNING");
    }
    // status RUNNING : processus précédent interrompu proprement (le run
    // n'avait jamais été retransitionné) — on continue directement.
    return this.processQueue(runId, shouldStop);
  }

  async retryEvent(eventId: string): Promise<void> {
    const event = await this.repo.getEvent(eventId);
    if (!event) throw new Error(`Event ${eventId} introuvable`);
    const status = event.status as WtBackfillEventStatus;
    if (status !== "BLOCKED" && status !== "FAILED") {
      throw new Error(`retry refuse un event ${status} (seuls BLOCKED/FAILED sont retry-able)`);
    }
    await this.repo.retryEvent(eventId, `retry manuel (tentative précédente: ${event.attempt_count})`);
  }

  async status(runId: string) {
    const run = await this.repo.getRun(runId);
    if (!run) throw new Error(`Run ${runId} introuvable`);
    const events = await this.repo.getEvents(runId);
    const current = events.find((e) => e.status === "RUNNING") ?? null;
    return { run, events, current };
  }

  // --- Boucle de traitement (séquentielle, verrouillée) --------------------
  private async processQueue(runId: string, shouldStop: () => boolean) {
    await withRunLock(runId, async () => {
      // Crash recovery : tout event RUNNING trouvé ici est un reliquat d'un
      // processus précédent mort sans nettoyage (le seul processus légitime
      // qui pourrait l'avoir laissé RUNNING tient déjà le lock ci-dessus).
      const stale = await this.repo.findStaleRunningEvents(runId);
      for (const event of stale) {
        await this.repo.recoverStaleEvent(event.id, "RUNNING périmé détecté au démarrage — repris idempotemment");
        this.logger.warn(`Event ${event.slug} : RUNNING périmé récupéré (reprise idempotente).`);
      }

      for (;;) {
        if (shouldStop()) {
          this.logger.log(`Run ${runId} : arrêt demandé (SIGINT/SIGTERM), aucun nouvel event ne sera démarré.`);
          break;
        }
        const event = await this.repo.findNextProcessableEvent(runId);
        if (!event) {
          await this.repo.recomputeRunCounters(runId);
          await this.repo.setRunStatus(runId, "RUNNING", "COMPLETED");
          this.logger.log(`Run ${runId} : COMPLETED (queue épuisée).`);
          break;
        }

        const outcome = await this.processEvent(event.id, event.slug, event.event_date_start, shouldStop);
        await this.repo.recomputeRunCounters(runId);

        if (outcome === "INTERRUPTED") break; // event redevenu PENDING, run reste RUNNING
        if (outcome !== "COMPLETED") {
          const runStatus = runStatusAfterEventOutcome(outcome);
          if (runStatus) {
            await this.repo.setRunStatus(runId, "RUNNING", runStatus);
            this.logger.warn(`Run ${runId} : arrêté (${runStatus}) sur l'event ${event.slug}.`);
          }
          break; // fail-closed : jamais "log and continue"
        }
      }
    });
    return this.repo.getRun(runId);
  }

  // Traite UN event : liste ses catégories, appelle runPilot catégorie par
  // catégorie (pipeline existant, inchangé), agrège les stats, décide de
  // l'issue. Jamais de logique Muju/Roma/Tashkent : uniquement des signaux
  // génériques déjà exposés par PilotImportReport.
  private async processEvent(
    eventId: string,
    slug: string,
    dateStart: Date | null,
    shouldStop: () => boolean,
  ): Promise<WtBackfillEventStatus | "INTERRUPTED"> {
    await this.repo.markEventRunning(eventId);
    const startedAt = Date.now();
    const eventBefore = await this.repo.getEvent(eventId);
    // Reprise "au mieux" : si une tentative précédente avait déjà avancé
    // (last_completed_category), on repart de ses stats persistées plutôt que
    // de tout remettre à zéro — sinon les catégories déjà validées avant un
    // crash/retry disparaîtraient du rapport final de l'event.
    const progress: EventProgress =
      eventBefore?.last_completed_category && eventBefore.stats ? { ...emptyProgress(), ...(eventBefore.stats as unknown as EventProgress) } : emptyProgress();
    const year = (dateStart ?? new Date()).getUTCFullYear();

    let categories: string[];
    try {
      const listing = await this.importer.fetchResultsListing(slug);
      categories = listing.categories.map((c) => c.label).sort((a, b) => a.localeCompare(b));
    } catch (error) {
      if (error instanceof WtrBlockedError) {
        progress.durationMs = Date.now() - startedAt;
        await this.repo.finishEvent(eventId, "BLOCKED", progress, error.message);
        return "BLOCKED";
      }
      progress.durationMs = Date.now() - startedAt;
      await this.repo.finishEvent(eventId, "FAILED", progress, (error as Error).message);
      return "FAILED";
    }

    const toProcess = categories.length > 0 ? categories : [undefined as unknown as string];
    const resumeAfter = eventBefore?.last_completed_category ?? null;
    const startIndex = resumeAfter ? toProcess.findIndex((c) => c === resumeAfter) + 1 : 0;

    for (let i = Math.max(startIndex, 0); i < toProcess.length; i++) {
      if (shouldStop()) {
        await this.repo.resetRunningEventToPending(eventId, `interrompu proprement avant catégorie "${toProcess[i]}"`);
        return "INTERRUPTED";
      }
      const categoryLabel = toProcess[i];

      let report;
      try {
        report = await this.importService.runPilot({
          year,
          slugs: [slug],
          categoryLabel: categoryLabel || undefined,
          refreshExisting: false,
        });
      } catch (error) {
        progress.durationMs = Date.now() - startedAt;
        await this.repo.finishEvent(eventId, "FAILED", progress, (error as Error).message);
        return "FAILED";
      }

      progress.pagesFetched += report.pagesFetched;
      const c = report.competitions[0];
      if (report.aborted) {
        progress.durationMs = Date.now() - startedAt;
        await this.repo.finishEvent(eventId, "BLOCKED", progress, report.aborted);
        return "BLOCKED";
      }
      if (!c || c.mapping?.verdict !== "SAFE" || !c.attach) {
        progress.durationMs = Date.now() - startedAt;
        const reason = c?.notes?.join("; ") || "mapping devenu non SAFE entre discovery et traitement";
        await this.repo.finishEvent(eventId, "BLOCKED", progress, reason);
        return "BLOCKED";
      }

      progress.matchesListed += c.matchesListed;
      progress.matchesCreated += c.matchesCreated;
      progress.matchesAttached += c.matchesAttached;
      progress.matchesRefreshed += c.matchesUpdated;
      progress.matchesSkippedExisting += c.matchesSkippedExisting;
      progress.parseFailures += c.matchesFailed.length;
      progress.conflicts += report.matches.conflicts;
      progress.ambiguous += report.matches.ambiguous;
      progress.athletesCreated += report.athletes.created;
      progress.athletesReused += report.athletes.reusedExisting;

      if (c.matchesFailed.length > 0) {
        progress.durationMs = Date.now() - startedAt;
        await this.repo.finishEvent(eventId, "FAILED", progress, `${c.matchesFailed.length} échec(s) de récupération/parsing sur "${categoryLabel}"`);
        return "FAILED";
      }
      if (report.matches.conflicts > 0 || report.matches.ambiguous > 0) {
        progress.durationMs = Date.now() - startedAt;
        await this.repo.finishEvent(
          eventId,
          "BLOCKED",
          progress,
          `${report.matches.conflicts} conflict(s), ${report.matches.ambiguous} ambiguous sur "${categoryLabel}"`,
        );
        return "BLOCKED";
      }

      progress.categoriesProcessed.push(categoryLabel);
      if (categoryLabel) await this.repo.recordEventProgress(eventId, categoryLabel, progress);
    }

    progress.durationMs = Date.now() - startedAt;
    await this.repo.finishEvent(eventId, "COMPLETED", progress, null);
    return "COMPLETED";
  }

  private yearsForScope(scope: WtBackfillScope): number[] {
    if (scope.kind === "year") return [scope.year];
    if (scope.kind === "slugs") return [...new Set(scope.years)];
    const fromY = Number(scope.from.slice(0, 4));
    const toY = Number(scope.to.slice(0, 4));
    if (!Number.isInteger(fromY) || !Number.isInteger(toY) || fromY > toY) return [];
    const years: number[] = [];
    for (let y = fromY; y <= toY; y++) years.push(y);
    return years;
  }

  private filterByScope(scope: WtBackfillScope, items: WtrCompetitionRef[]): WtrCompetitionRef[] {
    if (scope.kind === "year") {
      return items.filter((i) => i.dateStart.getUTCFullYear() === scope.year);
    }
    if (scope.kind === "slugs") {
      const wanted = new Set(scope.slugs);
      return items.filter((i) => wanted.has(i.slug));
    }
    const from = new Date(`${scope.from}T00:00:00.000Z`);
    const to = new Date(`${scope.to}T23:59:59.999Z`);
    return items.filter((i) => i.dateStart.getTime() >= from.getTime() && i.dateStart.getTime() <= to.getTime());
  }
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
