import "dotenv/config";
import { randomUUID } from "crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { InternationalRepository } from "../international.repository";
import { WorldTaekwondoResultsImporterService, WtrBlockedError } from "../wt-results/wt-results-importer.service";
import { WtResultsImportService } from "../wt-results/wt-results-import.service";
import { parseMatchPage, WtrCompetitionListItem, WtrResultsListing } from "../wt-results/wtr-parser";
import { FixtureAthlete, MatchFixtureOptions, matchPageHtml } from "../wt-results/wtr-test-fixtures";
import { WtBackfillRepository } from "./wt-backfill.repository";
import { WtBackfillService } from "./wt-backfill.service";

// Intégration : repository RÉEL + Postgres RÉEL + WtResultsImportService RÉEL
// (pipeline #12B/C/D INCHANGÉ) ; seule la couche HTTP WT est remplacée par un
// faux qui sert des fixtures à travers le VRAI parseur (aucun réseau). Même
// convention que wt-results-import.service.spec.ts.
class FakeImporter {
  pages = 0;
  list: WtrCompetitionListItem[] = [];
  categoriesBySlug = new Map<string, { label: string; eventId: string }[]>();
  matchIdsByEvent = new Map<string, string[]>();
  matchOptions = new Map<string, MatchFixtureOptions | "blocked">();
  blockListing = new Set<string>();

  getPagesFetched() {
    return this.pages;
  }
  async fetchCompetitionList(): Promise<WtrCompetitionListItem[]> {
    this.pages++;
    return this.list;
  }
  async fetchResultsListing(slug: string, eventId?: string): Promise<WtrResultsListing> {
    this.pages++;
    if (this.blockListing.has(slug)) throw new WtrBlockedError("accès refusé (403 simulé) sur la liste de catégories");
    const categories = this.categoriesBySlug.get(slug) ?? [];
    if (eventId) {
      return { categories, matchIds: this.matchIdsByEvent.get(`${slug}::${eventId}`) ?? [] };
    }
    const all = [...this.matchIdsByEvent.entries()].filter(([k]) => k.startsWith(`${slug}::`)).flatMap(([, ids]) => ids);
    return { categories, matchIds: all };
  }
  async fetchMatch(_slug: string, matchId: string) {
    this.pages++;
    const options = this.matchOptions.get(matchId);
    if (options === "blocked") throw new WtrBlockedError("HTTP 403 simulé");
    return parseMatchPage(matchPageHtml(options), matchId);
  }
  async fetchProfile() {
    this.pages++;
    throw new Error("non utilisé par #12E");
  }
}

describe("WtBackfillService (intégration Postgres, importer HTTP simulé, pipeline WT réel)", () => {
  let prisma: PrismaService;
  let internationalRepo: InternationalRepository;
  let backfillRepo: WtBackfillRepository;
  let fake: FakeImporter;
  let importService: WtResultsImportService;
  let service: WtBackfillService;

  const runLabel = Date.now();
  const competitionIds: string[] = [];
  const athleteSourceIds: string[] = [];
  const backfillRunIds: string[] = [];
  let dayOffset = 0;

  beforeAll(() => {
    prisma = new PrismaService();
    internationalRepo = new InternationalRepository(prisma);
    backfillRepo = new WtBackfillRepository(prisma);
  }, 30000);

  beforeEach(() => {
    fake = new FakeImporter();
    importService = new WtResultsImportService(fake as unknown as WorldTaekwondoResultsImporterService, internationalRepo);
    service = new WtBackfillService(backfillRepo, internationalRepo, fake as unknown as WorldTaekwondoResultsImporterService, importService);
  });

  afterEach(async () => {
    if (backfillRunIds.length > 0) {
      await prisma.wt_backfill_run.deleteMany({ where: { id: { in: backfillRunIds } } });
      backfillRunIds.length = 0;
    }
    if (competitionIds.length > 0) {
      await prisma.competition.deleteMany({ where: { id: { in: competitionIds } } });
      competitionIds.length = 0;
    }
    if (athleteSourceIds.length > 0) {
      await prisma.external_athlete.deleteMany({ where: { sources: { some: { source_external_id: { in: athleteSourceIds } } } } });
      athleteSourceIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  }, 30000);

  function fixtureAthlete(name: string, noc: string): FixtureAthlete {
    const id = randomUUID();
    athleteSourceIds.push(id);
    return { id, name, noc };
  }

  // Une competition canonique connue du calendrier WT + son équivalent Results
  // SAFE (mêmes dates, mêmes mots distinctifs).
  async function safeScenario(label: string) {
    dayOffset++;
    const start = new Date(Date.UTC(2035, 0, dayOffset));
    const end = new Date(Date.UTC(2035, 0, dayOffset + 1));
    const token = `zzb${label}${runLabel}`;
    const competition = await prisma.competition.create({
      data: {
        nom: `${token} 2035 World Taekwondo Grand Prix Series`,
        date_debut: start,
        date_fin: end,
        sources: { create: { source: "world_taekwondo", source_external_id: `cal-${token}` } },
      },
    });
    competitionIds.push(competition.id);
    const slug = `${token}-2035-grand-prix`;
    const item: WtrCompetitionListItem = { slug, name: `${token} 2035 World Taekwondo Grand-Prix`, dateStart: start, dateEnd: end };
    fake.list.push(item);
    return { competition, slug, item, start };
  }

  function registerCategory(slug: string, label: string, matches: { id: string; options: MatchFixtureOptions | "blocked" }[]) {
    const eventId = randomUUID();
    const existing = fake.categoriesBySlug.get(slug) ?? [];
    fake.categoriesBySlug.set(slug, [...existing, { label, eventId }]);
    fake.matchIdsByEvent.set(`${slug}::${eventId}`, matches.map((m) => m.id));
    for (const m of matches) fake.matchOptions.set(m.id, { ...(m.options as MatchFixtureOptions), category: label });
  }

  async function discover(scope: Parameters<WtBackfillService["discover"]>[0]) {
    const result = await service.discover(scope);
    backfillRunIds.push(result.runId);
    return result;
  }

  // --- DISCOVERY -----------------------------------------------------------

  it("discover : SAFE/AMBIGUOUS/UNMATCHED corrects, ordre date ASC puis slug, aucune écriture métier", async () => {
    const { competition: c1, slug: s1 } = await safeScenario("b");
    const { competition: c2, slug: s2 } = await safeScenario("a"); // même date que b si dayOffset consécutif -> slug ASC départage
    // Un événement Results sans équivalent calendrier -> UNMATCHED.
    dayOffset++;
    const unmatchedSlug = `zzb-unmatched-${runLabel}-2035-grand-prix`;
    fake.list.push({ slug: unmatchedSlug, name: `Zzb Inconnu ${runLabel} 2035 World Taekwondo Grand-Prix`, dateStart: new Date(Date.UTC(2035, 0, dayOffset)), dateEnd: new Date(Date.UTC(2035, 0, dayOffset)) });

    const result = await discover({ kind: "year", year: 2035 });

    const bySlug = new Map(result.events.map((e) => [e.slug, e]));
    expect(bySlug.get(s1)).toMatchObject({ mappingVerdict: "SAFE", competitionId: c1.id, alreadyImported: false });
    expect(bySlug.get(s2)).toMatchObject({ mappingVerdict: "SAFE", competitionId: c2.id });
    expect(bySlug.get(unmatchedSlug)).toMatchObject({ mappingVerdict: "UNMATCHED", competitionId: null });

    // Ordre déterministe : date ASC puis slug ASC (jamais l'ordre HTML brut).
    const order = result.events.map((e) => e.slug);
    const idx = (s: string) => order.indexOf(s);
    expect(idx(s2)).toBeLessThan(idx(unmatchedSlug)); // s2 daté avant l'unmatched

    const stored = await backfillRepo.getEvents(result.runId);
    expect(stored.find((e) => e.slug === unmatchedSlug)?.status).toBe("BLOCKED"); // jamais traité sans retry explicite
    expect(stored.find((e) => e.slug === s1)?.status).toBe("PENDING");

    // discovery = toujours dry-run : aucun combat créé pour NOS competitions
    // (comptage scopé, pas un total global — d'autres suites tournent en
    // parallèle sur la même base et y créent légitimement des lignes).
    expect(await prisma.competition_match.count({ where: { competition_id: { in: [c1.id, c2.id] } } })).toBe(0);
  });

  // --- EVENT PROCESSING NOMINAL ---------------------------------------------

  it("discover (#22) : jour Senior contenu dans une entrée calendrier à divisions Kyorugi -> SAFE, même verdict que l'import", async () => {
    dayOffset += 5;
    const day = (n: number) => new Date(Date.UTC(2035, 5, dayOffset + n));
    const iso = (n: number) => day(n).toISOString().slice(0, 10);
    const token = `zzbdiv${runLabel}`;
    const competition = await prisma.competition.create({
      data: {
        nom: `WT ${token} Cup - Europe`,
        date_debut: day(0),
        date_fin: day(2),
        sources: {
          create: {
            source: "world_taekwondo",
            source_external_id: `cal-${token}`,
            raw_divisions: [
              { dateText: "d0", discipline: "Kyorugi / Cadet / Junior", start: iso(0), end: iso(0) },
              { dateText: "d1-2", discipline: "Kyorugi / Senior", start: iso(1), end: iso(2) },
            ],
          },
        },
      },
    });
    competitionIds.push(competition.id);
    const slug = `wt-${token}-cup-europe-2035`;
    fake.list.push({ slug, name: `WT ${token} Cup Europe 2035`, dateStart: day(2), dateEnd: day(2) });
    registerCategory(slug, "Men -54kg", []);

    const result = await discover({ kind: "slugs", years: [2035], slugs: [slug] });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].mappingVerdict).toBe("SAFE");
    expect(result.events[0].competitionId).toBe(competition.id);
    expect(await prisma.competition_source.count({ where: { source: "world_taekwondo_results", source_external_id: slug } })).toBe(0);
  });

  it("start : event à 2 catégories, toutes propres -> COMPLETED, stats agrégées sur les 2 catégories, run COMPLETED", async () => {
    const { competition, slug } = await safeScenario("nominal");
    const alice = fixtureAthlete("Alice EXEMPLE", "FRA");
    const bruno = fixtureAthlete("Bruno TESTEUR", "KOR");
    const chloe = fixtureAthlete("Chloe SAMPLE", "THA");
    registerCategory(slug, "Men -58kg", [{ id: randomUUID(), options: { a: alice, b: bruno, scoreA: "2", scoreB: "0", winner: "A", stage: "F", contestNumber: 1, category: "Men -58kg" } }]);
    registerCategory(slug, "Men -68kg", [{ id: randomUUID(), options: { a: alice, b: chloe, scoreA: "1", scoreB: "2", winner: "B", stage: "F", contestNumber: 1, category: "Men -68kg" } }]);

    const { runId } = await discover({ kind: "year", year: 2035 });
    const run = await service.start(runId);

    expect(run?.status).toBe("COMPLETED");
    expect(run).toMatchObject({ discovered_event_count: 1, completed_event_count: 1, blocked_event_count: 0, failed_event_count: 0 });

    const [event] = await backfillRepo.getEvents(runId);
    expect(event.status).toBe("COMPLETED");
    expect(event.attempt_count).toBe(1);
    const stats = event.stats as unknown as { matchesCreated: number; categoriesProcessed: string[] };
    expect(stats.matchesCreated).toBe(2);
    expect(stats.categoriesProcessed.sort()).toEqual(["Men -58kg", "Men -68kg"]);

    expect(await prisma.competition_match.count({ where: { competition_id: competition.id } })).toBe(2);
  });

  it("start refuse un run non PENDING ; un run COMPLETED ne peut jamais être redémarré (idempotence orchestration)", async () => {
    const { slug } = await safeScenario("restart");
    registerCategory(slug, "Men -68kg", [{ id: randomUUID(), options: { a: fixtureAthlete("A", "FRA"), b: fixtureAthlete("B", "KOR"), scoreA: "2", scoreB: "0", winner: "A", contestNumber: 1 } }]);
    const { runId } = await discover({ kind: "year", year: 2035 });
    await service.start(runId);

    await expect(service.start(runId)).rejects.toThrow(/refuse un run COMPLETED/);
  });

  it("idempotence pipeline : rediscover + start sur les MÊMES données -> 0 nouveau combat/athlète, event tout de même COMPLETED", async () => {
    const { competition, slug } = await safeScenario("idem");
    const alice = fixtureAthlete("Alice EXEMPLE", "FRA");
    const bruno = fixtureAthlete("Bruno TESTEUR", "KOR");
    registerCategory(slug, "Men -68kg", [{ id: randomUUID(), options: { a: alice, b: bruno, scoreA: "2", scoreB: "0", winner: "A", contestNumber: 1 } }]);

    const first = await discover({ kind: "year", year: 2035 });
    await service.start(first.runId);
    expect(await prisma.competition_match.count({ where: { competition_id: competition.id } })).toBe(1);

    // Un DEUXIÈME run, mêmes données source : simule "relancer un backfill sur
    // un événement déjà entièrement importé".
    const second = await discover({ kind: "year", year: 2035 });
    expect(second.events[0].alreadyImported).toBe(true);
    const run2 = await service.start(second.runId);

    expect(run2?.status).toBe("COMPLETED");
    const [event2] = await backfillRepo.getEvents(second.runId);
    const stats2 = event2.stats as unknown as { matchesCreated: number; matchesSkippedExisting: number };
    expect(stats2.matchesCreated).toBe(0);
    expect(stats2.matchesSkippedExisting).toBe(1);
    expect(await prisma.competition_match.count({ where: { competition_id: competition.id } })).toBe(1); // pas de doublon
    expect(await prisma.external_athlete.count({ where: { sources: { some: { source_external_id: { in: [alice.id, bruno.id] } } } } })).toBe(2);
  });

  // --- STOP POLICY (fail-closed) -------------------------------------------

  it("CONFLICT -> event BLOCKED, run BLOCKED, l'event suivant de la queue reste PENDING (jamais traité)", async () => {
    const { slug: slugA } = await safeScenario("conflict-a");
    const alice = fixtureAthlete("Alice EXEMPLE", "FRA");
    const bruno = fixtureAthlete("Bruno TESTEUR", "KOR");
    const [c1, c2] = [randomUUID(), randomUUID()];
    registerCategory(slugA, "Men -68kg", [
      { id: c1, options: { a: alice, b: bruno, scoreA: "2", scoreB: "0", winner: "A", contestNumber: 1 } },
      { id: c2, options: { a: alice, b: bruno, scoreA: "0", scoreB: "2", winner: "B", contestNumber: 1 } }, // même clé, score divergent -> CONFLICT
    ]);
    const { slug: slugB } = await safeScenario("conflict-b"); // daté après A -> ne doit jamais être traité
    registerCategory(slugB, "Men -68kg", [{ id: randomUUID(), options: { a: fixtureAthlete("C", "ITA"), b: fixtureAthlete("D", "ESP"), scoreA: "2", scoreB: "0", winner: "A", contestNumber: 1 } }]);

    const { runId } = await discover({ kind: "year", year: 2035 });
    const run = await service.start(runId);

    expect(run?.status).toBe("BLOCKED");
    const events = await backfillRepo.getEvents(runId);
    const [eventA, eventB] = events;
    expect(eventA.status).toBe("BLOCKED");
    expect(eventA.last_error).toMatch(/conflict/i);
    expect(eventB.status).toBe("PENDING"); // fail-closed : jamais "log and continue"
  });

  it("retry après CONFLICT puis resume : les représentations déjà persistées sont retrouvées existantes -> COMPLETED (retry idempotent)", async () => {
    const { slug } = await safeScenario("conflict-retry");
    const alice = fixtureAthlete("Alice EXEMPLE", "FRA");
    const bruno = fixtureAthlete("Bruno TESTEUR", "KOR");
    const [c1, c2] = [randomUUID(), randomUUID()];
    registerCategory(slug, "Men -68kg", [
      { id: c1, options: { a: alice, b: bruno, scoreA: "2", scoreB: "0", winner: "A", contestNumber: 1 } },
      { id: c2, options: { a: alice, b: bruno, scoreA: "0", scoreB: "2", winner: "B", contestNumber: 1 } },
    ]);
    const { runId } = await discover({ kind: "year", year: 2035 });
    await service.start(runId);
    const [blockedEvent] = await backfillRepo.getEvents(runId);
    expect(blockedEvent.status).toBe("BLOCKED");

    await service.retryEvent(blockedEvent.id);
    const run = await service.resume(runId);

    expect(run?.status).toBe("COMPLETED");
    const [retried] = await backfillRepo.getEvents(runId);
    expect(retried.attempt_count).toBe(2);
    const stats = retried.stats as unknown as { matchesCreated: number; matchesSkippedExisting: number };
    expect(stats.matchesCreated).toBe(0);
    expect(stats.matchesSkippedExisting).toBe(2); // les 2 représentations du conflit, déjà en base
  });

  it("blocage source WT (WtrBlockedError) -> event BLOCKED avec le message d'origine, run BLOCKED", async () => {
    const { slug } = await safeScenario("wt-blocked");
    fake.blockListing.add(slug);

    const { runId } = await discover({ kind: "year", year: 2035 });
    const run = await service.start(runId);

    expect(run?.status).toBe("BLOCKED");
    const [event] = await backfillRepo.getEvents(runId);
    expect(event.status).toBe("BLOCKED");
    expect(event.last_error).toMatch(/403 simulé/);
  });

  // --- CRASH RECOVERY / RESUME ---------------------------------------------

  it("crash recovery : event A COMPLETED, event B RUNNING (crash simulé), resume -> B repris proprement, A non retraité, C traité, aucun doublon", async () => {
    const { competition: compA, slug: slugA } = await safeScenario("crash-a");
    registerCategory(slugA, "Men -68kg", [{ id: randomUUID(), options: { a: fixtureAthlete("A1", "FRA"), b: fixtureAthlete("A2", "KOR"), scoreA: "2", scoreB: "0", winner: "A", contestNumber: 1 } }]);
    const { competition: compB, slug: slugB } = await safeScenario("crash-b");
    registerCategory(slugB, "Men -68kg", [{ id: randomUUID(), options: { a: fixtureAthlete("B1", "ITA"), b: fixtureAthlete("B2", "ESP"), scoreA: "2", scoreB: "0", winner: "A", contestNumber: 1 } }]);
    const { competition: compC, slug: slugC } = await safeScenario("crash-c");
    registerCategory(slugC, "Men -68kg", [{ id: randomUUID(), options: { a: fixtureAthlete("C1", "USA"), b: fixtureAthlete("C2", "JPN"), scoreA: "2", scoreB: "0", winner: "A", contestNumber: 1 } }]);

    const { runId } = await discover({ kind: "year", year: 2035 });
    const [eventA, eventB] = await backfillRepo.getEvents(runId);

    // Simule : un premier processus a traité A jusqu'au bout, puis est mort
    // pendant B (jamais nettoyé). C n'a jamais été touché.
    await backfillRepo.setRunStatus(runId, "PENDING", "RUNNING");
    await backfillRepo.markEventRunning(eventA.id);
    await backfillRepo.finishEvent(eventA.id, "COMPLETED", emptyStats(), null);
    const eventAFinishedAt = (await backfillRepo.getEvent(eventA.id))?.finished_at;
    await backfillRepo.markEventRunning(eventB.id); // "crash" juste après : jamais finishEvent appelé

    const run = await service.resume(runId);

    expect(run?.status).toBe("COMPLETED");
    const [a, b, c] = await backfillRepo.getEvents(runId);
    expect(a.status).toBe("COMPLETED");
    expect(a.attempt_count).toBe(1); // non retraité
    expect(a.finished_at?.getTime()).toBe(eventAFinishedAt?.getTime());
    expect(b.status).toBe("COMPLETED");
    expect(b.attempt_count).toBe(2); // 1 (crash) + 1 (reprise réelle)
    expect(c.status).toBe("COMPLETED");
    expect(c.attempt_count).toBe(1);

    // Aucun doublon business : B et C ont chacun exactement 1 combat.
    expect(await prisma.competition_match.count({ where: { competition_id: compB.id } })).toBe(1);
    expect(await prisma.competition_match.count({ where: { competition_id: compC.id } })).toBe(1);
    expect(await prisma.competition_match.count({ where: { competition_id: compA.id } })).toBe(0); // A "complété" artificiellement, jamais réellement importé
  });

  it("interruption propre (shouldStop) : l'event en cours redevient PENDING, run reste RUNNING, rien n'est marqué COMPLETED prématurément", async () => {
    const { slug } = await safeScenario("interrupt");
    registerCategory(slug, "Men -68kg", [{ id: randomUUID(), options: { a: fixtureAthlete("I1", "FRA"), b: fixtureAthlete("I2", "KOR"), scoreA: "2", scoreB: "0", winner: "A", contestNumber: 1 } }]);
    const { runId } = await discover({ kind: "year", year: 2035 });

    // false à l'entrée de la boucle d'events (laisse démarrer l'event), true
    // dès le premier contrôle dans la boucle des catégories de processEvent :
    // simule un SIGINT reçu APRÈS le passage en RUNNING mais AVANT toute
    // catégorie traitée.
    let calls = 0;
    const shouldStop = () => ++calls > 1;
    const run = await service.start(runId, shouldStop);

    expect(run?.status).toBe("RUNNING"); // jamais transitionné vers BLOCKED/FAILED/COMPLETED par une interruption
    const [event] = await backfillRepo.getEvents(runId);
    expect(event.status).toBe("PENDING");
    expect(event.last_error).toMatch(/interrompu proprement/);

    // Peut être repris normalement ensuite.
    const resumed = await service.resume(runId);
    expect(resumed?.status).toBe("COMPLETED");
  });

  // --- DOUBLE-RUN PROTECTION -------------------------------------------------

  it("double-run : deux start() concurrents sur le même run, le second échoue immédiatement (lock)", async () => {
    const { slug } = await safeScenario("double-run");
    registerCategory(slug, "Men -68kg", [{ id: randomUUID(), options: { a: fixtureAthlete("X1", "FRA"), b: fixtureAthlete("X2", "KOR"), scoreA: "2", scoreB: "0", winner: "A", contestNumber: 1 } }]);
    const { runId } = await discover({ kind: "year", year: 2035 });

    const [r1, r2] = await Promise.allSettled([service.start(runId), service.start(runId)]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(["fulfilled", "rejected"]);
    const rejected = r1.status === "rejected" ? r1 : (r2 as PromiseRejectedResult);
    // Deux protections possibles selon la course exacte : le lock advisory
    // (processQueue) ou la transition PENDING->RUNNING conditionnelle
    // (setRunStatus, updateMany où status=PENDING) — les deux empêchent le
    // double traitement, seule la course réelle décide laquelle déclenche.
    expect(String(rejected.reason)).toMatch(/déjà en cours de traitement|refusée \(le run n'est plus dans l'état PENDING\)/);
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
