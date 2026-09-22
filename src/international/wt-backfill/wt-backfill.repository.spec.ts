import "dotenv/config";
import { randomUUID } from "crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { forbidTables, modifiedRows, snapshotRows } from "../preexisting-rows.snapshot";
import { NewBackfillEvent, WtBackfillRepository } from "./wt-backfill.repository";

// Intégration contre la vraie base Postgres locale (CLAUDE.md §23) : CHECK
// constraints, contrainte unique (run_id, slug) et comportement transactionnel
// de createRunWithEvents sont du vrai SQL qu'un mock ne peut pas valider.
// Chaque run créé ici est nettoyé en afterEach (cascade sur ses events).
describe("WtBackfillRepository (intégration Postgres)", () => {
  let prisma: PrismaService;
  let repo: WtBackfillRepository;
  let fakeCompetitionId: string;
  const runIds: string[] = [];
  const runId = randomUUID();

  beforeAll(async () => {
    prisma = new PrismaService();
    repo = new WtBackfillRepository(prisma);
    // Competition canonique factice (référencée par la FK competition_id des
    // events SAFE — le CHECK constraint exige un competition_id non null).
    const competition = await prisma.competition.create({
      data: { nom: `Backfill Repo Test ${runId}`, date_debut: new Date(Date.UTC(2034, 0, 1)) },
    });
    fakeCompetitionId = competition.id;
  }, 30000);

  afterEach(async () => {
    if (runIds.length > 0) {
      await prisma.wt_backfill_run.deleteMany({ where: { id: { in: runIds } } });
      runIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.competition.delete({ where: { id: fakeCompetitionId } });
    await prisma.$disconnect();
  }, 30000);

  function events(n: number, mapping: "SAFE" | "AMBIGUOUS" | "UNMATCHED" = "SAFE"): NewBackfillEvent[] {
    return Array.from({ length: n }, (_, i) => ({
      slug: `test-slug-${randomUUID()}-${i}`,
      eventName: `Test Event ${i}`,
      dateStart: new Date(Date.UTC(2034, 0, i + 1)),
      dateEnd: new Date(Date.UTC(2034, 0, i + 2)),
      mappingVerdict: mapping,
      competitionId: mapping === "SAFE" ? fakeCompetitionId : null,
      status: mapping === "SAFE" ? "PENDING" : "BLOCKED",
    }));
  }

  async function createRun(evts: NewBackfillEvent[]) {
    const run = await repo.createRunWithEvents({ kind: "year", year: 2034 }, evts);
    runIds.push(run.id);
    return run;
  }

  it("création run + events : atomique, ordre figé = ordre du tableau, statut initial PENDING", async () => {
    const evts = events(3);
    const run = await createRun(evts);
    expect(run.status).toBe("PENDING");

    const stored = await repo.getEvents(run.id);
    expect(stored).toHaveLength(3);
    expect(stored.map((e) => e.sequence)).toEqual([0, 1, 2]);
    expect(stored.map((e) => e.slug)).toEqual(evts.map((e) => e.slug));
    expect(stored.every((e) => e.status === "PENDING")).toBe(true);
  });

  it("un mapping non SAFE est BLOCKED dès la création, jamais traitable", async () => {
    const run = await createRun([...events(1, "SAFE"), ...events(1, "AMBIGUOUS")]);
    const stored = await repo.getEvents(run.id);
    expect(stored.map((e) => e.status)).toEqual(["PENDING", "BLOCKED"]);
    // Le CHECK constraint interdit un competition_id sur un event non SAFE.
    expect(stored[1].competition_id).toBeNull();
  });

  it("queue immuable : (run_id, slug) est unique, aucun ajout après coup possible via cette méthode", async () => {
    const evts = events(1);
    const run = await createRun(evts);
    await expect(
      prisma.wt_backfill_event.create({
        data: {
          run_id: run.id,
          sequence: 99,
          slug: evts[0].slug, // même slug que l'event déjà créé pour ce run
          mapping_verdict: "SAFE",
          status: "PENDING",
        },
      }),
    ).rejects.toThrow();
  });

  it("findNextProcessableEvent : seul PENDING, dans l'ordre, jamais COMPLETED", async () => {
    const run = await createRun(events(3));
    const [e0, e1] = await repo.getEvents(run.id);

    const first = await repo.findNextProcessableEvent(run.id);
    expect(first?.slug).toBe(e0.slug);

    await repo.markEventRunning(e0.id);
    await repo.finishEvent(e0.id, "COMPLETED", emptyStats(), null);

    const next = await repo.findNextProcessableEvent(run.id);
    expect(next?.slug).toBe(e1.slug); // e0 COMPLETED : jamais retourné à nouveau
  });

  it("transitions de statut event : PENDING->RUNNING->COMPLETED, attempt_count incrémenté", async () => {
    const run = await createRun(events(1));
    const [e0] = await repo.getEvents(run.id);
    expect(e0.attempt_count).toBe(0);

    await repo.markEventRunning(e0.id);
    const running = await repo.getEvent(e0.id);
    expect(running?.status).toBe("RUNNING");
    expect(running?.attempt_count).toBe(1);
    expect(running?.started_at).not.toBeNull();

    await repo.finishEvent(e0.id, "COMPLETED", emptyStats(), null);
    const done = await repo.getEvent(e0.id);
    expect(done?.status).toBe("COMPLETED");
    expect(done?.finished_at).not.toBeNull();
  });

  it("finishEvent refuse une transition invalide (COMPLETED ne peut pas redevenir BLOCKED)", async () => {
    const run = await createRun(events(1));
    const [e0] = await repo.getEvents(run.id);
    await repo.markEventRunning(e0.id);
    await repo.finishEvent(e0.id, "COMPLETED", emptyStats(), null);
    await expect(repo.finishEvent(e0.id, "BLOCKED", emptyStats(), "trop tard")).rejects.toThrow();
  });

  it("stale RUNNING : détecté et récupéré en PENDING, jamais supposé terminé", async () => {
    const run = await createRun(events(1));
    const [e0] = await repo.getEvents(run.id);
    await repo.markEventRunning(e0.id); // simule un process mort en plein traitement

    const stale = await repo.findStaleRunningEvents(run.id);
    expect(stale.map((e) => e.id)).toEqual([e0.id]);

    await repo.recoverStaleEvent(e0.id, "reprise test");
    const recovered = await repo.getEvent(e0.id);
    expect(recovered?.status).toBe("PENDING");
    expect(recovered?.attempt_count).toBe(1); // pas de doublon de tentative, juste repris
  });

  it("retry : BLOCKED/FAILED -> PENDING, mais refuse depuis COMPLETED", async () => {
    const run = await createRun(events(1));
    const [e0] = await repo.getEvents(run.id);
    await repo.markEventRunning(e0.id);
    await repo.finishEvent(e0.id, "FAILED", emptyStats(), "erreur réseau simulée");

    await repo.retryEvent(e0.id, "retry test");
    const retried = await repo.getEvent(e0.id);
    expect(retried?.status).toBe("PENDING");

    await repo.markEventRunning(e0.id);
    await repo.finishEvent(e0.id, "COMPLETED", emptyStats(), null);
    await expect(repo.retryEvent(e0.id, "trop tard")).rejects.toThrow();
  });

  it("recomputeRunCounters : agrège completed/blocked/failed/discovered correctement", async () => {
    const run = await createRun(events(3));
    const [e0, e1, e2] = await repo.getEvents(run.id);
    await repo.markEventRunning(e0.id);
    await repo.finishEvent(e0.id, "COMPLETED", emptyStats(), null);
    await repo.markEventRunning(e1.id);
    await repo.finishEvent(e1.id, "BLOCKED", emptyStats(), "conflict");
    // e2 reste PENDING

    await repo.recomputeRunCounters(run.id);
    const updated = await repo.getRun(run.id);
    expect(updated).toMatchObject({ discovered_event_count: 3, completed_event_count: 1, blocked_event_count: 1, failed_event_count: 0 });
  });

  it("setRunStatus refuse une transition invalide et ne modifie rien", async () => {
    const run = await createRun(events(1));
    await expect(repo.setRunStatus(run.id, "PENDING", "COMPLETED")).rejects.toThrow();
    const unchanged = await repo.getRun(run.id);
    expect(unchanged?.status).toBe("PENDING");
  });

  it("resetRunningEventToPending : interruption propre, jamais marqué COMPLETED", async () => {
    const run = await createRun(events(1));
    const [e0] = await repo.getEvents(run.id);
    await repo.markEventRunning(e0.id);
    await repo.resetRunningEventToPending(e0.id, "SIGINT reçu");
    const event = await repo.getEvent(e0.id);
    expect(event?.status).toBe("PENDING");
    expect(event?.last_error).toContain("SIGINT");
  });

  it("dry-run safety : createRunWithEvents ne touche à AUCUNE table métier (compteurs inchangés, accès structurellement bloqué sur participation/competition_entry/athlete)", async () => {
    // Comptages globaux volontairement PAS utilisés ici pour competition_match/
    // external_athlete/competition/competition_source : Jest exécute les
    // suites en parallèle sur la même base (d'autres suites créent
    // légitimement des lignes pendant ce test), donc seuls modifiedRows()
    // (lignes présentes avant ET après, jamais leur nombre) et l'accès
    // structurellement bloqué sont fiables ici (voir preexisting-rows.snapshot.ts).
    const before = await snapshotRows(prisma);

    // Le repository de discovery n'a structurellement AUCUN accès à ces
    // tables : un Prisma proxifié qui lève une erreur au premier accès le
    // prouve, pas seulement "il se trouve qu'il n'y touche pas".
    const guardedPrisma = forbidTables(prisma, ["participation", "competition_entry", "athlete"]);
    const guardedRepo = new WtBackfillRepository(guardedPrisma);
    const run = await guardedRepo.createRunWithEvents({ kind: "year", year: 2034 }, events(5));
    runIds.push(run.id);

    const after = await snapshotRows(prisma);
    expect(modifiedRows(before, after)).toEqual([]);
  });
});

function emptyStats() {
  return {
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
  };
}
