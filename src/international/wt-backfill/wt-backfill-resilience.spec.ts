import { EventEmitter } from "events";
import { InternationalRepository } from "../international.repository";
import { WorldTaekwondoResultsImporterService, WtrHttpError } from "../wt-results/wt-results-importer.service";
import { WtResultsImportService } from "../wt-results/wt-results-import.service";
import { backoffDelayMs, describeDbError, isTransientDbError } from "./wt-backfill-db-errors";
import { LockClient, RunLockLostError, withRunLock } from "./wt-backfill-lock";
import { EventProgress, WtBackfillRepository } from "./wt-backfill.repository";
import { WtBackfillService } from "./wt-backfill.service";
import {
  assertValidEventTransition,
  assertValidRunTransition,
  WtBackfillEventStatus,
  WtBackfillRunStatus,
} from "./wt-backfill-state";

// Tests 100 % SIMULÉS (aucune connexion PostgreSQL, aucun réseau) : coupures
// PostgreSQL pendant un backfill et reprise après interruption. Le repository
// est remplacé par un double en mémoire qui applique la MÊME machine d'état
// (wt-backfill-state) que le vrai ; le pipeline WT est remplacé par un double
// idempotent (un match déjà présent est ignoré, comme findExistingMatchIds).

// --- Erreurs simulées ----------------------------------------------------
const pgSocketTimeout = () => Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT", errno: -60, syscall: "read" });
const prismaConnectionClosed = () =>
  Object.assign(new Error("Server has closed the connection."), { name: "PrismaClientKnownRequestError", code: "P1017" });

// --- Faux serveur d'advisory locks + faux pg.Client ------------------------
class FakeLockServer {
  holder: FakeLockClient | null = null;
  ghostHolds = 0; // nb de try_lock qui voient encore l'ancienne session morte
  refuseConnections = 0;
  clients: FakeLockClient[] = [];
}

class FakeLockClient extends EventEmitter implements LockClient {
  dead = false;
  constructor(private readonly server: FakeLockServer) {
    super();
    server.clients.push(this);
  }
  async connect() {
    if (this.server.refuseConnections > 0) {
      this.server.refuseConnections--;
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    }
  }
  async query<R>(sql: string): Promise<{ rows: R[] }> {
    if (this.dead) throw new Error("Client has encountered a connection error and is not queryable");
    if (sql.includes("pg_try_advisory_lock")) {
      if (this.server.ghostHolds > 0) {
        this.server.ghostHolds--;
        return { rows: [{ locked: false } as R] };
      }
      const locked = this.server.holder === null || this.server.holder === this;
      if (locked) this.server.holder = this;
      return { rows: [{ locked } as R] };
    }
    if (sql.includes("pg_advisory_unlock")) {
      if (this.server.holder === this) this.server.holder = null;
      return { rows: [] };
    }
    return { rows: [] };
  }
  async end() {
    if (this.server.holder === this) this.server.holder = null;
  }
  // Coupure socket côté serveur : la session meurt, son lock est relâché.
  kill(error: Error) {
    this.dead = true;
    if (this.server.holder === this) this.server.holder = null;
    this.emit("error", error); // lève si aucun listener => le crash d'origine
  }
}

// --- Double en mémoire du repository -------------------------------------
interface FakeEvent {
  id: string;
  run_id: string;
  sequence: number;
  slug: string;
  event_date_start: Date | null;
  status: WtBackfillEventStatus;
  attempt_count: number;
  last_completed_category: string | null;
  stats: EventProgress | null;
  last_error: string | null;
}

class FakeRepo {
  run = { id: "run-1", status: "RUNNING" as WtBackfillRunStatus, completed_event_count: 0, blocked_event_count: 0, failed_event_count: 0 };
  events: FakeEvent[] = [];
  // Injection de pannes : nom de méthode -> fabriques d'erreurs consommées une par une.
  faults = new Map<string, (() => Error)[]>();
  // Pannes "après commit" : l'écriture est appliquée puis l'acquittement est perdu.
  lostAcks = new Map<string, number>();

  addEvent(slug: string, status: WtBackfillEventStatus, extra: Partial<FakeEvent> = {}) {
    this.events.push({
      id: `ev-${slug}`,
      run_id: this.run.id,
      sequence: this.events.length,
      slug,
      event_date_start: new Date("2026-05-01T00:00:00Z"),
      status,
      attempt_count: 0,
      last_completed_category: null,
      stats: null,
      last_error: null,
      ...extra,
    });
  }
  event(slug: string) {
    return this.events.find((e) => e.slug === slug)!;
  }
  private fault(method: string) {
    const queue = this.faults.get(method);
    const make = queue?.shift();
    if (make) throw make();
  }
  private lostAck(method: string) {
    const n = this.lostAcks.get(method) ?? 0;
    if (n > 0) {
      this.lostAcks.set(method, n - 1);
      throw prismaConnectionClosed();
    }
  }
  private byId(id: string) {
    const e = this.events.find((x) => x.id === id);
    if (!e) throw new Error(`event ${id} introuvable`);
    return e;
  }

  async getRun() {
    this.fault("getRun");
    return { ...this.run };
  }
  async setRunStatus(_runId: string, from: WtBackfillRunStatus, to: WtBackfillRunStatus) {
    this.fault("setRunStatus");
    assertValidRunTransition(from, to);
    if (this.run.status !== from) throw new Error(`transition ${from} -> ${to} refusée (run ${this.run.status})`);
    this.run.status = to;
    this.lostAck("setRunStatus");
  }
  async ensureRunStatus(runId: string, from: WtBackfillRunStatus, to: WtBackfillRunStatus) {
    assertValidRunTransition(from, to);
    if (this.run.status === to) return;
    await this.setRunStatus(runId, from, to);
  }
  async recomputeRunCounters() {
    this.fault("recomputeRunCounters");
    this.run.completed_event_count = this.events.filter((e) => e.status === "COMPLETED").length;
    this.run.blocked_event_count = this.events.filter((e) => e.status === "BLOCKED").length;
    this.run.failed_event_count = this.events.filter((e) => e.status === "FAILED").length;
  }
  async getEvent(id: string) {
    this.fault("getEvent");
    return { ...this.byId(id) };
  }
  async findNextProcessableEvent() {
    this.fault("findNextProcessableEvent");
    const next = [...this.events].sort((a, b) => a.sequence - b.sequence).find((e) => e.status === "PENDING");
    return next ? { ...next } : null;
  }
  async findStaleRunningEvents() {
    this.fault("findStaleRunningEvents");
    return this.events.filter((e) => e.status === "RUNNING").map((e) => ({ ...e }));
  }
  async recoverStaleEvent(id: string, note: string) {
    const e = this.byId(id);
    assertValidEventTransition(e.status, "PENDING");
    e.status = "PENDING";
    e.last_error = note;
  }
  async markEventRunning(id: string) {
    this.fault("markEventRunning");
    const e = this.byId(id);
    assertValidEventTransition(e.status, "RUNNING");
    e.status = "RUNNING";
    e.attempt_count++;
  }
  async recordEventProgress(id: string, category: string, stats: EventProgress) {
    this.fault("recordEventProgress");
    const e = this.byId(id);
    e.last_completed_category = category;
    e.stats = JSON.parse(JSON.stringify(stats));
  }
  async finishEvent(id: string, outcome: WtBackfillEventStatus, stats: EventProgress, lastError: string | null) {
    this.fault("finishEvent");
    const e = this.byId(id);
    assertValidEventTransition(e.status, outcome);
    e.status = outcome;
    e.stats = JSON.parse(JSON.stringify(stats));
    e.last_error = lastError;
  }
  async resetRunningEventToPending(id: string, note: string) {
    const e = this.byId(id);
    if (e.status === "RUNNING") {
      e.status = "PENDING";
      e.last_error = note;
    }
  }
}

// --- Double idempotent du pipeline WT (runPilot) ---------------------------
type CategoryBehavior = "ok" | "blocked" | "conflict" | (() => Error);

class FakePipeline {
  categoriesBySlug = new Map<string, string[]>();
  matchesByCategory = new Map<string, string[]>(); // `${slug}::${cat}` -> matchIds
  // "Base" : matchs et athlètes persistés (clés uniques comme [source, source_external_id]).
  storedMatches = new Map<string, number>(); // matchId -> nb d'écritures
  storedAthletes = new Map<string, number>();
  behaviors = new Map<string, CategoryBehavior[]>(); // consommés par appel
  calls: string[] = [];

  async fetchResultsListing(slug: string) {
    return { categories: (this.categoriesBySlug.get(slug) ?? []).map((label) => ({ label, eventId: label })), matchIds: [] };
  }

  async runPilot(options: { slugs: string[]; categoryLabel?: string }) {
    const slug = options.slugs[0];
    const key = `${slug}::${options.categoryLabel}`;
    this.calls.push(key);
    const behavior = this.behaviors.get(key)?.shift() ?? "ok";
    const matchIds = this.matchesByCategory.get(key) ?? [];
    let created = 0;
    let skipped = 0;
    let athletesCreated = 0;
    let athletesReused = 0;

    // Écrit la moitié des matchs puis "coupe" si demandé : simule une
    // coupure DB au milieu d'une catégorie (écritures partielles commitées).
    const cutAt = typeof behavior === "function" ? Math.ceil(matchIds.length / 2) : matchIds.length;
    for (const [index, matchId] of matchIds.entries()) {
      if (index === cutAt && typeof behavior === "function") throw behavior();
      if (this.storedMatches.has(matchId)) {
        skipped++;
        continue;
      }
      this.storedMatches.set(matchId, (this.storedMatches.get(matchId) ?? 0) + 1);
      created++;
      for (const athlete of [`${matchId}-a`, `${matchId}-b`]) {
        if (this.storedAthletes.has(athlete)) athletesReused++;
        else {
          this.storedAthletes.set(athlete, 1);
          athletesCreated++;
        }
      }
    }
    if (typeof behavior === "function") throw behavior();

    return {
      pagesFetched: 1,
      aborted: behavior === "blocked" ? "anti-bot simulé" : undefined,
      competitions: [
        {
          mapping: { verdict: "SAFE" },
          attach: { competitionSourceId: "cs-1" },
          matchesListed: matchIds.length,
          matchesCreated: created,
          matchesAttached: 0,
          matchesUpdated: 0,
          matchesSkippedExisting: skipped,
          matchesFailed: [],
          notes: [],
        },
      ],
      matches: { conflicts: behavior === "conflict" ? 1 : 0, ambiguous: 0 },
      athletes: { created: athletesCreated, reusedExisting: athletesReused },
    };
  }
}

function setup() {
  const repo = new FakeRepo();
  const pipeline = new FakePipeline();
  const lockServer = new FakeLockServer();
  const sleeps: number[] = [];
  const service = new WtBackfillService(
    repo as unknown as WtBackfillRepository,
    {} as InternationalRepository,
    pipeline as unknown as WorldTaekwondoResultsImporterService,
    pipeline as unknown as WtResultsImportService,
  );
  service.resilience = {
    dbRetry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 40 },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    lock: {
      createClient: () => new FakeLockClient(lockServer),
      reacquirePolicy: { maxAttempts: 4, baseDelayMs: 5, maxDelayMs: 20 },
      sleep: async () => {},
      log: () => {},
    },
  };
  // Silence le Logger Nest pendant les tests.
  (service as unknown as { logger: { log: () => void; warn: () => void; error: () => void } }).logger = {
    log: () => {},
    warn: () => {},
    error: () => {},
  };
  return { repo, pipeline, lockServer, sleeps, service };
}

function seedEvent(pipeline: FakePipeline, slug: string, categories: string[], matchesPerCategory = 4) {
  pipeline.categoriesBySlug.set(slug, categories);
  for (const cat of categories) {
    pipeline.matchesByCategory.set(
      `${slug}::${cat}`,
      Array.from({ length: matchesPerCategory }, (_, i) => `${slug}-${cat}-m${i}`),
    );
  }
}

const noDuplicates = (pipeline: FakePipeline) =>
  [...pipeline.storedMatches.values(), ...pipeline.storedAthletes.values()].every((count) => count === 1);

// ==========================================================================
describe("isTransientDbError (classification pure)", () => {
  it.each([
    ["socket pg ETIMEDOUT (erreur d'origine)", pgSocketTimeout()],
    ["socket ECONNRESET", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    ["Prisma P1017 connexion fermée", prismaConnectionClosed()],
    ["Prisma P1001 injoignable", Object.assign(new Error("Can't reach database server"), { code: "P1001" })],
    ["Prisma init errorCode", Object.assign(new Error("init"), { errorCode: "P1001" })],
    ["DriverAdapterError SocketTimeout", Object.assign(new Error("x"), { cause: { kind: "SocketTimeout" } })],
    ["SQLSTATE 57P01 admin shutdown", Object.assign(new Error("terminating connection"), { code: "57P01" })],
    ["SQLSTATE 08006", Object.assign(new Error("connection failure"), { code: "08006" })],
    ["message pg sans code", new Error("Connection terminated unexpectedly")],
    ["cause imbriquée", new Error("wrap", { cause: pgSocketTimeout() })],
  ])("transitoire : %s", (_label, error) => {
    expect(isTransientDbError(error)).toBe(true);
  });

  it.each([
    ["contrainte unique P2002", Object.assign(new Error("Unique constraint"), { code: "P2002" })],
    ["erreur métier", new Error("Transition d'event invalide: COMPLETED -> RUNNING")],
    ["HTTP WT ETIMEDOUT (jamais une coupure DB)", new WtrHttpError("requête impossible: read ETIMEDOUT")],
    ["non-objet", "boom"],
    ["null", null],
  ])("NON transitoire : %s", (_label, error) => {
    expect(isTransientDbError(error)).toBe(false);
  });

  it("backoff exponentiel borné", () => {
    const policy = { maxAttempts: 9, baseDelayMs: 2000, maxDelayMs: 60000 };
    expect([1, 2, 3, 4, 5, 6, 7, 9].map((a) => backoffDelayMs(a, policy))).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });

  it("describeDbError ne laisse jamais fuiter l'URL de connexion", () => {
    const message = describeDbError(new Error("failed for postgresql://user:s3cret@db.example:5432/postgres?sslmode=require"));
    expect(message).not.toContain("s3cret");
    expect(message).toContain("postgresql://***");
  });
});

// ==========================================================================
describe("withRunLock (faux pg.Client, aucune DB)", () => {
  const opts = (server: FakeLockServer, maxAttempts = 4) => ({
    createClient: () => new FakeLockClient(server),
    reacquirePolicy: { maxAttempts, baseDelayMs: 1, maxDelayMs: 1 },
    sleep: async () => {},
    log: () => {},
  });

  it("reproduit la cause racine : 'error' sans listener sur un EventEmitter lève (crash)", () => {
    const bare = new EventEmitter();
    expect(() => bare.emit("error", pgSocketTimeout())).toThrow("read ETIMEDOUT");
  });

  it("un ETIMEDOUT sur la connexion idle du lock ne crashe plus, puis le lock est réacquis", async () => {
    const server = new FakeLockServer();
    await withRunLock(
      "run-x",
      async (lock) => {
        const first = server.clients[0];
        expect(server.holder).toBe(first);
        expect(() => first.kill(pgSocketTimeout())).not.toThrow();
        await lock.ensureHeld();
        expect(server.holder).not.toBe(first);
        expect(server.holder).toBe(server.clients[server.clients.length - 1]);
      },
      opts(server),
    );
    expect(server.holder).toBeNull(); // relâché en sortie
  });

  it("session morte sans événement 'error' : détectée par le ping, réacquise", async () => {
    const server = new FakeLockServer();
    await withRunLock(
      "run-x",
      async (lock) => {
        const first = server.clients[0];
        first.dead = true;
        server.holder = null;
        await lock.ensureHeld();
        expect(server.holder).not.toBe(first);
      },
      opts(server),
    );
  });

  it("réacquisition avec backoff : le serveur voit encore l'ancienne session, puis la relâche", async () => {
    const server = new FakeLockServer();
    await withRunLock(
      "run-x",
      async (lock) => {
        server.clients[0].kill(pgSocketTimeout());
        server.ghostHolds = 2;
        server.refuseConnections = 1;
        await lock.ensureHeld();
        expect(server.holder).toBe(server.clients[server.clients.length - 1]);
      },
      opts(server),
    );
  });

  it("lock pris par un autre processus pendant la coupure : RunLockLostError borné, aucune boucle infinie", async () => {
    const server = new FakeLockServer();
    const intruder = new FakeLockClient(server);
    await expect(
      withRunLock(
        "run-x",
        async (lock) => {
          server.clients[1].kill(pgSocketTimeout());
          await intruder.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked");
          await lock.ensureHeld();
        },
        opts(server, 3),
      ),
    ).rejects.toBeInstanceOf(RunLockLostError);
    expect(server.holder).toBe(intruder); // jamais volé à l'autre processus
  });
});

// ==========================================================================
describe("WtBackfillService — coupures PostgreSQL et reprise (simulé)", () => {
  it("coupure DB au milieu d'une catégorie : reprise depuis le checkpoint, catégorie rejouée sans doublon", async () => {
    const { repo, pipeline, service, sleeps } = setup();
    seedEvent(pipeline, "tashkent-2026", ["A", "B", "C"]);
    repo.addEvent("tashkent-2026", "PENDING");
    pipeline.behaviors.set("tashkent-2026::B", [prismaConnectionClosed]);

    const run = await service.resume("run-1");

    expect(run?.status).toBe("COMPLETED");
    const ev = repo.event("tashkent-2026");
    expect(ev.status).toBe("COMPLETED");
    expect(ev.attempt_count).toBe(2);
    // A n'est jamais rejouée (checkpoint conservé) ; B rejouée une fois.
    expect(pipeline.calls).toEqual(["tashkent-2026::A", "tashkent-2026::B", "tashkent-2026::B", "tashkent-2026::C"]);
    expect(ev.stats?.categoriesProcessed).toEqual(["A", "B", "C"]);
    expect(pipeline.storedMatches.size).toBe(12);
    expect(noDuplicates(pipeline)).toBe(true);
    expect(sleeps).toEqual([10]); // un seul backoff
  });

  it("socket ETIMEDOUT sur une requête de suivi (repository) : backoff puis poursuite du run", async () => {
    const { repo, pipeline, service, sleeps } = setup();
    seedEvent(pipeline, "ev-1", ["A"]);
    seedEvent(pipeline, "ev-2", ["A"]);
    repo.addEvent("ev-1", "PENDING");
    repo.addEvent("ev-2", "PENDING");
    repo.faults.set("findNextProcessableEvent", [pgSocketTimeout, pgSocketTimeout]);
    repo.faults.set("recordEventProgress", [pgSocketTimeout]);

    const run = await service.resume("run-1");

    expect(run?.status).toBe("COMPLETED");
    expect(repo.events.map((e) => e.status)).toEqual(["COMPLETED", "COMPLETED"]);
    expect(sleeps).toEqual([10, 20, 40]); // aucun progrès entre ces trois coupures : budget non remis à zéro
    expect(noDuplicates(pipeline)).toBe(true);
  });

  it("panne DB persistante : abandon borné, event laissé RUNNING (jamais FAILED), puis reprise après redémarrage", async () => {
    const first = setup();
    const { repo, pipeline } = first;
    seedEvent(pipeline, "done-event", ["A"]);
    seedEvent(pipeline, "tashkent-2026", ["A", "B", "C"]);
    repo.addEvent("done-event", "COMPLETED", { attempt_count: 1 });
    repo.addEvent("unmatched-event", "BLOCKED");
    repo.addEvent("tashkent-2026", "PENDING");
    const outage = () => prismaConnectionClosed();
    pipeline.behaviors.set("tashkent-2026::B", [outage]);
    // resume() lit le run une fois (OK), puis chaque tentative de reprise le relit (KO).
    let getRunCalls = 0;
    const realGetRun = repo.getRun.bind(repo);
    repo.getRun = async () => {
      getRunCalls++;
      if (getRunCalls > 2) throw outage();
      return realGetRun();
    };

    await expect(first.service.resume("run-1")).rejects.toMatchObject({ code: "P1017" });
    expect(first.sleeps).toEqual([10, 20, 40]); // maxAttempts=3, plafonné à 40
    expect(repo.event("tashkent-2026").status).toBe("RUNNING");
    expect(repo.event("tashkent-2026").last_completed_category).toBe("A");
    expect(repo.run.status).toBe("RUNNING");
    expect(first.lockServer.holder).toBeNull(); // lock relâché malgré l'abandon

    // "Redémarrage" du CLI : nouveau service, même état persistant.
    const second = setup();
    second.repo.run = repo.run;
    second.repo.events = repo.events;
    second.pipeline.categoriesBySlug = pipeline.categoriesBySlug;
    second.pipeline.matchesByCategory = pipeline.matchesByCategory;
    second.pipeline.storedMatches = pipeline.storedMatches;
    second.pipeline.storedAthletes = pipeline.storedAthletes;

    const run = await second.service.resume("run-1");

    expect(run?.status).toBe("COMPLETED");
    expect(second.pipeline.calls).toEqual(["tashkent-2026::B", "tashkent-2026::C"]);
    expect(repo.event("done-event")).toMatchObject({ status: "COMPLETED", attempt_count: 1 }); // jamais retraité
    expect(repo.event("unmatched-event").status).toBe("BLOCKED"); // UNMATCHED jamais forcé
    expect(repo.event("tashkent-2026").stats?.categoriesProcessed).toEqual(["A", "B", "C"]);
    expect(noDuplicates(second.pipeline)).toBe(true);
  });

  it("crash dur (event resté RUNNING sans processus) : resume le récupère et repart après la dernière catégorie", async () => {
    const { repo, pipeline, service } = setup();
    seedEvent(pipeline, "tashkent-2026", ["A", "B", "C"]);
    // Etat laissé par le crash ETIMEDOUT : A et B validées, event RUNNING.
    pipeline.storedMatches = new Map(["A", "B"].flatMap((c) => [0, 1, 2, 3].map((i) => [`tashkent-2026-${c}-m${i}`, 1] as [string, number])));
    pipeline.storedAthletes = new Map([...pipeline.storedMatches.keys()].flatMap((m) => [[`${m}-a`, 1], [`${m}-b`, 1]] as [string, number][]));
    repo.addEvent("tashkent-2026", "RUNNING", {
      attempt_count: 1,
      last_completed_category: "B",
      stats: { categoriesProcessed: ["A", "B"], matchesListed: 8, matchesCreated: 8 } as EventProgress,
    });

    const run = await service.resume("run-1");

    expect(run?.status).toBe("COMPLETED");
    expect(pipeline.calls).toEqual(["tashkent-2026::C"]);
    expect(repo.event("tashkent-2026").stats).toMatchObject({ categoriesProcessed: ["A", "B", "C"], matchesCreated: 12 });
    expect(noDuplicates(pipeline)).toBe(true);
  });

  it("erreur NON transitoire dans le pipeline : comportement fail-closed inchangé (event + run FAILED, aucun retry)", async () => {
    const { repo, pipeline, service, sleeps } = setup();
    seedEvent(pipeline, "ev-1", ["A"]);
    seedEvent(pipeline, "ev-2", ["A"]);
    repo.addEvent("ev-1", "PENDING");
    repo.addEvent("ev-2", "PENDING");
    pipeline.behaviors.set("ev-1::A", [() => new Error("parse inattendu")]);

    const run = await service.resume("run-1");

    expect(run?.status).toBe("FAILED");
    expect(repo.event("ev-1").status).toBe("FAILED");
    expect(repo.event("ev-2").status).toBe("PENDING"); // jamais "log and continue"
    expect(sleeps).toEqual([]);
  });

  it("event BLOCKED puis coupure en écrivant le statut du run : run BLOCKED, l'event suivant n'est JAMAIS démarré", async () => {
    const { repo, pipeline, service } = setup();
    seedEvent(pipeline, "ev-1", ["A"]);
    seedEvent(pipeline, "ev-2", ["A"]);
    repo.addEvent("ev-1", "PENDING");
    repo.addEvent("ev-2", "PENDING");
    pipeline.behaviors.set("ev-1::A", ["conflict"]);
    repo.faults.set("setRunStatus", [pgSocketTimeout]);

    const run = await service.resume("run-1");

    expect(run?.status).toBe("BLOCKED");
    expect(repo.event("ev-1").status).toBe("BLOCKED");
    expect(repo.event("ev-2")).toMatchObject({ status: "PENDING", attempt_count: 0 });
    expect(pipeline.calls).toEqual(["ev-1::A"]);
  });

  it("acquittement perdu après commit du statut final : pas d'erreur de transition, run COMPLETED", async () => {
    const { repo, pipeline, service } = setup();
    seedEvent(pipeline, "ev-1", ["A"]);
    repo.addEvent("ev-1", "PENDING");
    repo.lostAcks.set("setRunStatus", 1);

    const run = await service.resume("run-1");

    expect(run?.status).toBe("COMPLETED");
    expect(pipeline.calls).toEqual(["ev-1::A"]);
  });

  it("ETIMEDOUT sur la connexion du lock pendant le traitement : le run continue après réacquisition", async () => {
    const { repo, pipeline, lockServer, service } = setup();
    seedEvent(pipeline, "ev-1", ["A", "B"]);
    repo.addEvent("ev-1", "PENDING");
    const original = pipeline.runPilot.bind(pipeline);
    let killed = false;
    pipeline.runPilot = async (options) => {
      if (!killed) {
        killed = true;
        lockServer.clients[0].kill(pgSocketTimeout()); // crashait le process avant le fix
      }
      return original(options);
    };

    const run = await service.resume("run-1");

    expect(run?.status).toBe("COMPLETED");
    expect(lockServer.clients.length).toBeGreaterThan(1); // session rouverte
    expect(lockServer.holder).toBeNull();
    expect(noDuplicates(pipeline)).toBe(true);
  });

  it("un run COMPLETED n'est jamais repris", async () => {
    const { repo, pipeline, service } = setup();
    repo.run.status = "COMPLETED";
    repo.addEvent("ev-1", "COMPLETED");
    await expect(service.resume("run-1")).rejects.toThrow("déjà COMPLETED");
    expect(pipeline.calls).toEqual([]);
  });
});
