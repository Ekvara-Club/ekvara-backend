import { Injectable } from "@nestjs/common";
import { Prisma } from "../../../generated/prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  assertValidEventTransition,
  assertValidRunTransition,
  WtBackfillEventStatus,
  WtBackfillRunStatus,
  WtrMappingVerdictForBackfill,
} from "./wt-backfill-state";

export interface NewBackfillEvent {
  slug: string;
  eventName: string | null;
  dateStart: Date | null;
  dateEnd: Date | null;
  mappingVerdict: WtrMappingVerdictForBackfill;
  competitionId: string | null;
  status: WtBackfillEventStatus;
}

export interface EventProgress {
  categoriesTotal?: number;
  categoriesProcessed: string[];
  matchesListed: number;
  matchesCreated: number;
  matchesAttached: number;
  matchesRefreshed: number;
  matchesSkippedExisting: number;
  conflicts: number;
  ambiguous: number;
  parseFailures: number;
  athletesCreated: number;
  athletesReused: number;
  pagesFetched: number;
  durationMs: number;
}

// Persistance PostgreSQL du moteur #12E. N'importe RIEN du pipeline WT
// Results (ça reste WtResultsImportService/WtrParser) : uniquement le suivi
// run/event. Toutes les écritures sont des UPDATE/INSERT ciblés d'une seule
// ligne — pas de transaction géante autour d'appels réseau (audit Phase 0 §5).
@Injectable()
export class WtBackfillRepository {
  constructor(private readonly prisma: PrismaService) {}

  // --- Run -------------------------------------------------------------
  async getRun(runId: string) {
    return this.prisma.wt_backfill_run.findUnique({ where: { id: runId } });
  }

  async setRunStatus(runId: string, from: WtBackfillRunStatus, to: WtBackfillRunStatus): Promise<void> {
    assertValidRunTransition(from, to);
    const data: Prisma.wt_backfill_runUpdateInput = { status: to };
    if (to === "RUNNING" && from === "PENDING") data.started_at = new Date();
    if (to === "COMPLETED" || to === "BLOCKED" || to === "FAILED") data.finished_at = new Date();
    const result = await this.prisma.wt_backfill_run.updateMany({ where: { id: runId, status: from }, data });
    if (result.count === 0) {
      throw new Error(`Run ${runId}: transition ${from} -> ${to} refusée (le run n'est plus dans l'état ${from})`);
    }
  }

  async recomputeRunCounters(runId: string): Promise<void> {
    const [completed, blocked, failed, discovered] = await Promise.all([
      this.prisma.wt_backfill_event.count({ where: { run_id: runId, status: "COMPLETED" } }),
      this.prisma.wt_backfill_event.count({ where: { run_id: runId, status: "BLOCKED" } }),
      this.prisma.wt_backfill_event.count({ where: { run_id: runId, status: "FAILED" } }),
      this.prisma.wt_backfill_event.count({ where: { run_id: runId } }),
    ]);
    await this.prisma.wt_backfill_run.update({
      where: { id: runId },
      data: {
        completed_event_count: completed,
        blocked_event_count: blocked,
        failed_event_count: failed,
        discovered_event_count: discovered,
      },
    });
  }

  // --- Events ------------------------------------------------------------
  // Création du run ET de sa queue en une seule transaction : jamais de run
  // orphelin sans events si le processus meurt entre les deux (atomicité de
  // la discovery). Ordre = ordre du tableau (déjà trié par le service : date
  // ASC puis slug). La queue est figée dès cet appel — aucune méthode ne
  // permet d'ajouter un event à un run existant après coup.
  async createRunWithEvents(
    scope: Prisma.InputJsonValue,
    events: NewBackfillEvent[],
  ): Promise<{ id: string; status: WtBackfillRunStatus }> {
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.wt_backfill_run.create({
        data: { status: "PENDING", requested_scope: scope, discovered_event_count: events.length },
        select: { id: true, status: true },
      });
      if (events.length > 0) {
        await tx.wt_backfill_event.createMany({
          data: events.map((e, index) => ({
            run_id: run.id,
            sequence: index,
            slug: e.slug,
            event_name: e.eventName,
            event_date_start: e.dateStart,
            event_date_end: e.dateEnd,
            mapping_verdict: e.mappingVerdict,
            competition_id: e.competitionId,
            status: e.status,
          })),
        });
      }
      return { id: run.id, status: run.status as WtBackfillRunStatus };
    });
  }

  // Slugs déjà connus de la source Results (competition_source), pour que la
  // discovery puisse rapporter "déjà importé" sans jamais rien écrire.
  async findAlreadyAttachedSlugs(slugs: string[]): Promise<Set<string>> {
    if (slugs.length === 0) return new Set();
    const rows = await this.prisma.competition_source.findMany({
      where: { source: "world_taekwondo_results", source_external_id: { in: slugs } },
      select: { source_external_id: true },
    });
    return new Set(rows.map((r) => r.source_external_id));
  }

  async getEvents(runId: string) {
    return this.prisma.wt_backfill_event.findMany({ where: { run_id: runId }, orderBy: { sequence: "asc" } });
  }

  async getEvent(eventId: string) {
    return this.prisma.wt_backfill_event.findUnique({ where: { id: eventId } });
  }

  // Premier event PENDING dans l'ordre de la queue — jamais un event
  // COMPLETED, jamais un ordre différent de celui figé à la discovery.
  async findNextProcessableEvent(runId: string) {
    return this.prisma.wt_backfill_event.findFirst({
      where: { run_id: runId, status: "PENDING" },
      orderBy: { sequence: "asc" },
    });
  }

  // Events RUNNING au démarrage = reliquat d'un crash précédent (#12E est
  // strictement séquentiel, un seul run actif à la fois sous le lock — voir
  // tryAcquireRunLock). Politique : reset explicite en PENDING, jamais
  // supposés terminés, jamais dupliqués (audit Phase 0, "Crash recovery").
  async findStaleRunningEvents(runId: string) {
    return this.prisma.wt_backfill_event.findMany({ where: { run_id: runId, status: "RUNNING" } });
  }

  async recoverStaleEvent(eventId: string, note: string): Promise<void> {
    const event = await this.prisma.wt_backfill_event.findUniqueOrThrow({ where: { id: eventId } });
    assertValidEventTransition(event.status as WtBackfillEventStatus, "PENDING");
    await this.prisma.wt_backfill_event.update({
      where: { id: eventId },
      data: { status: "PENDING", last_error: note },
    });
  }

  async markEventRunning(eventId: string): Promise<void> {
    const event = await this.prisma.wt_backfill_event.findUniqueOrThrow({ where: { id: eventId } });
    assertValidEventTransition(event.status as WtBackfillEventStatus, "RUNNING");
    await this.prisma.wt_backfill_event.update({
      where: { id: eventId },
      data: { status: "RUNNING", started_at: new Date(), attempt_count: { increment: 1 } },
    });
  }

  // Persistance de la progression intra-event (après chaque catégorie) —
  // reste RUNNING, ne change pas de statut. Sert la reprise "au mieux" sans
  // architecture de checkpoint intra-event lourde (audit Phase 0 §4).
  async recordEventProgress(eventId: string, lastCompletedCategory: string, stats: EventProgress): Promise<void> {
    await this.prisma.wt_backfill_event.update({
      where: { id: eventId },
      data: { last_completed_category: lastCompletedCategory, stats: stats as unknown as Prisma.InputJsonValue },
    });
  }

  async finishEvent(
    eventId: string,
    outcome: Extract<WtBackfillEventStatus, "COMPLETED" | "BLOCKED" | "FAILED">,
    stats: EventProgress,
    lastError: string | null,
  ): Promise<void> {
    const event = await this.prisma.wt_backfill_event.findUniqueOrThrow({ where: { id: eventId } });
    assertValidEventTransition(event.status as WtBackfillEventStatus, outcome);
    await this.prisma.wt_backfill_event.update({
      where: { id: eventId },
      data: {
        status: outcome,
        finished_at: new Date(),
        stats: stats as unknown as Prisma.InputJsonValue,
        last_error: lastError,
      },
    });
  }

  // Reset explicite (commande operator "retry") : FAILED ou BLOCKED -> PENDING.
  async retryEvent(eventId: string, note: string): Promise<void> {
    const event = await this.prisma.wt_backfill_event.findUniqueOrThrow({ where: { id: eventId } });
    assertValidEventTransition(event.status as WtBackfillEventStatus, "PENDING");
    await this.prisma.wt_backfill_event.update({
      where: { id: eventId },
      data: { status: "PENDING", last_error: note },
    });
  }

  // Interruption propre (SIGINT/SIGTERM) : l'event RUNNING actuel redevient
  // PENDING, jamais marqué COMPLETED en cours de route.
  async resetRunningEventToPending(eventId: string, note: string): Promise<void> {
    await this.prisma.wt_backfill_event.update({
      where: { id: eventId, status: "RUNNING" },
      data: { status: "PENDING", last_error: note },
    });
  }
}
