import "dotenv/config";
import { randomUUID } from "crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { InternationalRepository } from "../international.repository";
import { forbidTables, modifiedRows, snapshotRows } from "../preexisting-rows.snapshot";
import { WorldTaekwondoResultsImporterService, WtrBlockedError } from "./wt-results-importer.service";
import { MAX_PILOT_COMPETITIONS, PilotImportOptions, WtResultsImportService } from "./wt-results-import.service";
import { parseMatchPage, parseProfilePage, WtrCompetitionListItem, WtrResultsListing } from "./wtr-parser";
import { FixtureAthlete, MatchFixtureOptions, matchPageHtml, profilePageHtml } from "./wtr-test-fixtures";

// Intégration : repository RÉEL + Postgres RÉEL, importer HTTP remplacé par un
// faux qui sert des pages fixtures à travers le VRAI parseur (aucun réseau).
// Chaque test crée ses propres competitions canoniques (dates 2033, nom suffixé
// par runId) et ses athlètes (UUID aléatoires), nettoyés en afterEach.

class FakeImporter {
  pages = 0;
  calls: string[] = [];
  list: WtrCompetitionListItem[] = [];
  listings = new Map<string, WtrResultsListing>();
  matchOptions = new Map<string, MatchFixtureOptions | "blocked" | "raw:malformed">();
  profiles = new Map<string, { athlete: FixtureAthlete; record: string | null }>();

  getPagesFetched() {
    return this.pages;
  }
  async fetchCompetitionList() {
    this.pages++;
    this.calls.push("list");
    return this.list;
  }
  async fetchResultsListing(slug: string, eventId?: string) {
    this.pages++;
    this.calls.push(`listing:${slug}:${eventId ?? "all"}`);
    return this.listings.get(slug) ?? { categories: [], matchIds: [] };
  }
  async fetchMatch(_slug: string, matchId: string) {
    this.pages++;
    this.calls.push(`match:${matchId}`);
    const options = this.matchOptions.get(matchId);
    if (options === "blocked") throw new WtrBlockedError("HTTP 403 simulé");
    if (options === "raw:malformed") return parseMatchPage("<html><body>oops</body></html>", matchId);
    return parseMatchPage(matchPageHtml(options), matchId);
  }
  async fetchProfile(athleteId: string) {
    this.pages++;
    this.calls.push(`profile:${athleteId}`);
    const p = this.profiles.get(athleteId);
    return parseProfilePage(p ? profilePageHtml({ athlete: p.athlete, record: p.record }) : "<html/>", athleteId);
  }
  matchCalls() {
    return this.calls.filter((c) => c.startsWith("match:")).length;
  }
}

describe("WtResultsImportService (intégration Postgres, importer HTTP simulé)", () => {
  let prisma: PrismaService;
  let repository: InternationalRepository;
  let fake: FakeImporter;
  let service: WtResultsImportService;

  const runId = Date.now();
  const competitionIds: string[] = [];
  const athleteSourceIds: string[] = [];
  let dayOffset = 0;

  beforeAll(() => {
    prisma = new PrismaService();
    repository = new InternationalRepository(prisma);
  }, 30000);

  beforeEach(() => {
    fake = new FakeImporter();
    service = new WtResultsImportService(fake as unknown as WorldTaekwondoResultsImporterService, repository);
  });

  afterEach(async () => {
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

  // Une competition canonique connue du calendrier WT + son équivalent Results.
  async function scenario(label: string, resultsNameSuffix = "Grand-Prix", calendarNameSuffix = "Grand Prix Series") {
    dayOffset++;
    const start = new Date(Date.UTC(2033, 0, dayOffset));
    const end = new Date(Date.UTC(2033, 0, dayOffset + 2));
    const token = `zzq${label}${runId}`;
    const competition = await prisma.competition.create({
      data: {
        nom: `${token} 2033 World Taekwondo ${calendarNameSuffix}`,
        date_debut: start,
        date_fin: end,
        sources: { create: { source: "world_taekwondo", source_external_id: `cal-${token}` } },
      },
    });
    competitionIds.push(competition.id);
    const slug = `${token}-2033-grand-prix`;
    const item: WtrCompetitionListItem = {
      slug,
      name: `${token} 2033 World Taekwondo ${resultsNameSuffix}`,
      dateStart: start,
      dateEnd: end,
    };
    fake.list.push(item);
    return { competition, slug, item, token };
  }

  function registerMatches(slug: string, matches: { id: string; options: MatchFixtureOptions | "blocked" | "raw:malformed" }[]) {
    fake.listings.set(slug, { categories: [{ label: "Men -68kg", eventId: randomUUID() }], matchIds: matches.map((m) => m.id) });
    for (const m of matches) fake.matchOptions.set(m.id, m.options);
  }

  const run = (options: Partial<PilotImportOptions> & { slugs: string[] }) => service.runPilot({ year: 2033, ...options });

  async function countsFor(competitionId: string, slug: string) {
    return {
      matches: await prisma.competition_match.count({ where: { competition_id: competitionId } }),
      resultsSources: await prisma.competition_source.count({ where: { source: "world_taekwondo_results", source_external_id: slug } }),
      athleteSources: await prisma.external_athlete_source.count({ where: { source_external_id: { in: athleteSourceIds } } }),
      athletes: await prisma.external_athlete.count({ where: { sources: { some: { source_external_id: { in: athleteSourceIds } } } } }),
    };
  }

  it("SAFE : attache la source Results à la competition canonique et importe les matchs avec orientation, score, vainqueur et méthode fidèles à la page match", async () => {
    const { competition, slug } = await scenario("safe");
    const alice = fixtureAthlete("Alice EXEMPLE", "FRA");
    const bruno = fixtureAthlete("Bruno TESTEUR", "KOR");
    const chloe = fixtureAthlete("Chloe SAMPLE", "THA");
    const [m1, m2, m3] = [randomUUID(), randomUUID(), randomUUID()];
    registerMatches(slug, [
      { id: m1, options: { a: alice, b: bruno, scoreA: "2", scoreB: "1", winner: "A", stage: "SF", category: "Men -68kg", contestNumber: 11 } },
      // Vainqueur = B, affiché "0 - 2" dans l'ordre de la page (cas réel du résumé profil ambigu)
      { id: m2, options: { a: bruno, b: alice, scoreA: "0", scoreB: "2", winner: "B", stage: "F", category: "Men -68kg", contestNumber: 12 } },
      // RSC : le vainqueur (A) n'a PAS le score le plus élevé
      { id: m3, options: { a: alice, b: chloe, scoreA: "0", scoreB: "1", winner: "A", methodText: "Won by RSC", stage: "QF", category: "Men -68kg", contestNumber: 10 } },
    ]);
    const competitionBefore = JSON.stringify(await prisma.competition.findUniqueOrThrow({ where: { id: competition.id } }));

    const report = await run({ slugs: [slug] });

    expect(report.aborted).toBeNull();
    expect(report.competitions[0].mapping?.verdict).toBe("SAFE");
    expect(report.competitions[0].mapping?.competitionId).toBe(competition.id);
    expect(report.competitions[0].mapping?.calendarExternalIds).toEqual([expect.stringMatching(/^cal-zzq/)]);
    expect(report.competitions[0].attach).toBe("attached");
    expect(report.competitions[0].matchesCreated).toBe(3);
    expect(report.athletes).toMatchObject({ appearances: 6, unique: 3, created: 3, reusedExisting: 3, withoutNoc: 0 });
    expect(report.pagesFetched).toBe(1 + 1 + 3); // liste + listing + 3 pages match

    const sources = await prisma.competition_source.findMany({ where: { competition_id: competition.id }, orderBy: { created_at: "asc" } });
    expect(sources.map((s) => s.source)).toEqual(["world_taekwondo", "world_taekwondo_results"]);
    expect(sources[1]).toMatchObject({ source_external_id: slug, match_confidence: "safe", source_url: `https://results.worldtaekwondo.org/competitions/${slug}/results` });

    const stored = await prisma.competition_match.findMany({
      where: { competition_id: competition.id },
      include: { athlete_a: { include: { sources: true } }, athlete_b: { include: { sources: true } } },
      orderBy: { contest_number: "asc" },
    });
    const srcId = (a: { sources: { source_external_id: string }[] }) => a.sources[0].source_external_id;

    // contest 10 : Alice (A) bat Chloe (B) par RSC 0-1 → vainqueur = A malgré score_a < score_b
    expect([srcId(stored[0].athlete_a), srcId(stored[0].athlete_b)]).toEqual([alice.id, chloe.id]);
    expect([stored[0].score_a, stored[0].score_b, stored[0].result_method, stored[0].bracket_stage]).toEqual([0, 1, "RSC", "QF"]);
    expect(stored[0].winner_athlete_id).toBe(stored[0].athlete_a_id);
    // contest 11 : Alice (A) 2-1 Bruno (B), vainqueur A
    expect([srcId(stored[1].athlete_a), srcId(stored[1].athlete_b), stored[1].score_a, stored[1].score_b]).toEqual([alice.id, bruno.id, 2, 1]);
    expect(stored[1].winner_athlete_id).toBe(stored[1].athlete_a_id);
    // contest 12 : Bruno (A) 0-2 Alice (B), vainqueur B (= Alice)
    expect([srcId(stored[2].athlete_a), srcId(stored[2].athlete_b), stored[2].score_a, stored[2].score_b]).toEqual([bruno.id, alice.id, 0, 2]);
    expect(stored[2].winner_athlete_id).toBe(stored[2].athlete_b_id);
    // provenance
    expect(stored.every((m) => m.source === "world_taekwondo_results" && m.source_url?.includes(`/competitions/${slug}/results/`))).toBe(true);

    // la competition canonique elle-même n'a pas bougé
    expect(JSON.stringify(await prisma.competition.findUniqueOrThrow({ where: { id: competition.id } }))).toBe(competitionBefore);
  });

  it("idempotence : importer deux fois ⇒ 0 doublon d'athlète, de source d'athlète, de source compétition et de match ; 2ᵉ passe sans aucune requête match", async () => {
    const { competition, slug } = await scenario("idem");
    const [alice, bruno] = [fixtureAthlete("Alice EXEMPLE", "FRA"), fixtureAthlete("Bruno TESTEUR", "KOR")];
    const ids = [randomUUID(), randomUUID()];
    registerMatches(slug, ids.map((id, i) => ({ id, options: { a: alice, b: bruno, contestNumber: i + 1 } })));

    await run({ slugs: [slug] });
    const first = await countsFor(competition.id, slug);
    expect(first).toEqual({ matches: 2, resultsSources: 1, athleteSources: 2, athletes: 2 });
    const matchCallsAfterFirst = fake.matchCalls();

    const second = await run({ slugs: [slug] });
    expect(await countsFor(competition.id, slug)).toEqual(first);
    expect(fake.matchCalls()).toBe(matchCallsAfterFirst); // aucune re-télécharge (matchs déjà connus)
    expect(second.competitions[0]).toMatchObject({ attach: "refreshed", matchesSkippedExisting: 2, matchesCreated: 0 });
    expect(second.athletes.appearances).toBe(0);
  });

  it("idempotence avec refreshExisting : re-télécharge les matchs, les met à jour, et ne crée toujours aucun doublon", async () => {
    const { competition, slug } = await scenario("refresh");
    const [alice, bruno] = [fixtureAthlete("Alice EXEMPLE", "FRA"), fixtureAthlete("Bruno TESTEUR", "KOR")];
    const id = randomUUID();
    registerMatches(slug, [{ id, options: { a: alice, b: bruno, scoreA: "2", scoreB: "1", winner: "A" } }]);

    await run({ slugs: [slug] });
    const first = await countsFor(competition.id, slug);

    // La source corrige le score entre-temps.
    fake.matchOptions.set(id, { a: alice, b: bruno, scoreA: "1", scoreB: "2", winner: "B" });
    const second = await run({ slugs: [slug], refreshExisting: true });

    expect(second.competitions[0]).toMatchObject({ matchesUpdated: 1, matchesCreated: 0 });
    expect(await countsFor(competition.id, slug)).toEqual(first);
    const stored = await prisma.competition_match.findFirstOrThrow({ where: { competition_id: competition.id } });
    expect([stored.score_a, stored.score_b]).toEqual([1, 2]);
    expect(stored.winner_athlete_id).toBe(stored.athlete_b_id);
  });

  it("un même athlète (même UUID) rencontré dans deux compétitions ⇒ un seul external_athlete", async () => {
    const one = await scenario("multi1");
    const two = await scenario("multi2");
    const alice = fixtureAthlete("Alice EXEMPLE", "FRA");
    const [bruno, chloe] = [fixtureAthlete("Bruno TESTEUR", "KOR"), fixtureAthlete("Chloe SAMPLE", "THA")];
    registerMatches(one.slug, [{ id: randomUUID(), options: { a: alice, b: bruno } }]);
    registerMatches(two.slug, [{ id: randomUUID(), options: { a: chloe, b: alice } }]);

    const report = await run({ slugs: [one.slug, two.slug] });

    expect(report.athletes).toMatchObject({ appearances: 4, unique: 3, created: 3, reusedExisting: 1 });
    expect(await prisma.external_athlete_source.count({ where: { source_external_id: alice.id } })).toBe(1);
    expect(await prisma.external_athlete.count({ where: { sources: { some: { source_external_id: { in: athleteSourceIds } } } } })).toBe(3);
  });

  it("mappingOnly : rapporte le verdict SAFE mais n'écrit RIEN (ni source, ni athlète, ni match) et ne télécharge aucun match", async () => {
    const { competition, slug } = await scenario("mapping-only");
    registerMatches(slug, [{ id: randomUUID(), options: { a: fixtureAthlete("A", "FRA"), b: fixtureAthlete("B", "KOR") } }]);

    const report = await run({ slugs: [slug], mappingOnly: true });

    expect(report.competitions[0].mapping).toMatchObject({ verdict: "SAFE", competitionId: competition.id });
    expect(report.competitions[0].attach).toBeNull();
    expect(await countsFor(competition.id, slug)).toEqual({ matches: 0, resultsSources: 0, athleteSources: 0, athletes: 0 });
    expect(fake.calls).toEqual(["list"]);
  });

  describe("mapping non SAFE ⇒ aucune donnée écrite", () => {
    it("UNMATCHED (nom identique mais dates Results différentes)", async () => {
      const { competition, slug, item } = await scenario("unmatched");
      item.dateStart = new Date(Date.UTC(2033, 5, 1));
      item.dateEnd = new Date(Date.UTC(2033, 5, 3));
      const [alice, bruno] = [fixtureAthlete("A", "FRA"), fixtureAthlete("B", "KOR")];
      registerMatches(slug, [{ id: randomUUID(), options: { a: alice, b: bruno } }]);

      const report = await run({ slugs: [slug] });

      expect(report.competitions[0].mapping?.verdict).toBe("UNMATCHED");
      expect(report.competitions[0].attach).toBeNull();
      expect(await countsFor(competition.id, slug)).toEqual({ matches: 0, resultsSources: 0, athleteSources: 0, athletes: 0 });
      expect(fake.matchCalls()).toBe(0);
    });

    it("AMBIGUOUS (deux competitions canoniques équivalentes)", async () => {
      const { competition, slug, item, token } = await scenario("ambig");
      const twin = await prisma.competition.create({
        data: {
          nom: `${token} 2033 Grand Prix`,
          date_debut: competition.date_debut,
          date_fin: competition.date_fin,
          sources: { create: { source: "world_taekwondo", source_external_id: `cal-twin-${token}` } },
        },
      });
      competitionIds.push(twin.id);
      registerMatches(slug, [{ id: randomUUID(), options: { a: fixtureAthlete("A", "FRA"), b: fixtureAthlete("B", "KOR") } }]);

      const report = await run({ slugs: [slug] });

      expect(item.slug).toBe(slug);
      expect(report.competitions[0].mapping?.verdict).toBe("AMBIGUOUS");
      expect(await countsFor(competition.id, slug)).toEqual({ matches: 0, resultsSources: 0, athleteSources: 0, athletes: 0 });
      expect(await prisma.competition_match.count({ where: { competition_id: twin.id } })).toBe(0);
    });

    it("slug absent de la liste Results ⇒ note, rien d'écrit", async () => {
      const report = await run({ slugs: ["slug-inexistant"] });
      expect(report.competitions[0].notes[0]).toMatch(/absent de la liste/);
      expect(report.competitions[0].mapping).toBeNull();
    });

    it("slug déjà rattaché à une AUTRE competition ⇒ refus explicite, aucun match importé", async () => {
      const { slug } = await scenario("conflict");
      const other = await prisma.competition.create({
        data: { nom: `Autre ${runId}`, date_debut: new Date(Date.UTC(2034, 0, 1)), sources: { create: { source: "world_taekwondo_results", source_external_id: slug } } },
      });
      competitionIds.push(other.id);
      registerMatches(slug, [{ id: randomUUID(), options: { a: fixtureAthlete("A", "FRA"), b: fixtureAthlete("B", "KOR") } }]);

      const report = await run({ slugs: [slug] });

      expect(report.competitions[0].notes.join(" ")).toMatch(/refus de la déplacer/);
      expect(fake.matchCalls()).toBe(0);
      expect(await prisma.competition_match.count({ where: { competition_id: other.id } })).toBe(0);
    });
  });

  describe("données imparfaites de la source", () => {
    it("page match malformée ⇒ rapportée en échec, les autres matchs sont importés", async () => {
      const { competition, slug } = await scenario("malformed");
      const [alice, bruno] = [fixtureAthlete("Alice EXEMPLE", "FRA"), fixtureAthlete("Bruno TESTEUR", "KOR")];
      const [good, bad] = [randomUUID(), randomUUID()];
      registerMatches(slug, [
        { id: bad, options: "raw:malformed" },
        { id: good, options: { a: alice, b: bruno } },
      ]);

      const report = await run({ slugs: [slug] });

      expect(report.competitions[0].matchesCreated).toBe(1);
      expect(report.competitions[0].matchesFailed).toEqual([{ matchId: bad, reason: expect.stringMatching(/participants/) }]);
      expect(await prisma.competition_match.count({ where: { competition_id: competition.id } })).toBe(1);
    });

    it("compte et rapporte : match sans vainqueur, sans score, athlète sans NOC ; les données sont conservées, jamais fabriquées", async () => {
      const { competition, slug } = await scenario("sparse");
      const noNoc = fixtureAthlete("Sans NOC", "");
      const bruno = fixtureAthlete("Bruno TESTEUR", "KOR");
      const id = randomUUID();
      registerMatches(slug, [{ id, options: { a: noNoc, b: bruno, scoreA: "", scoreB: "", winner: null, methodText: "" } }]);

      const report = await run({ slugs: [slug] });

      expect(report.matches).toMatchObject({ withoutWinner: 1, withoutScore: 1 });
      expect(report.athletes.withoutNoc).toBe(1);
      expect(report.anomalies.join("\n")).toMatch(/NOC/);
      const stored = await prisma.competition_match.findFirstOrThrow({ where: { competition_id: competition.id }, include: { athlete_a: true } });
      expect([stored.score_a, stored.score_b, stored.winner_athlete_id, stored.result_method]).toEqual([null, null, null, null]);
      expect(stored.athlete_a.country_code).toBeNull();
    });

    // --- Ticket #12B : une représentation source != un combat réel -----------------

    async function storedFor(competitionId: string) {
      const matches = await prisma.competition_match.findMany({
        where: { competition_id: competitionId },
        include: { sources: true },
        orderBy: { created_at: "asc" },
      });
      return {
        matches,
        sources: matches.flatMap((m) => m.sources.map((s) => s.source_external_id)).sort(),
      };
    }

    it("SAME LOGICAL FIGHT : 4 représentations source identiques ⇒ UN competition_match, les 4 identifiants conservés comme provenance", async () => {
      const { competition, slug } = await scenario("same4");
      const [alice, bruno] = [fixtureAthlete("Alice EXEMPLE", "FRA"), fixtureAthlete("Bruno TESTEUR", "KOR")];
      const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const options = { a: alice, b: bruno, scoreA: "2", scoreB: "0", winner: "A" as const, stage: "F", contestNumber: 1 };
      registerMatches(slug, ids.map((id) => ({ id, options })));

      const report = await run({ slugs: [slug] });

      expect(report.competitions[0]).toMatchObject({ matchesFetched: 4, matchesCreated: 1, matchesAttached: 3, matchesConflicts: 0 });
      expect(report.matches).toMatchObject({ sameLogicalFight: 3, conflicts: 0, ambiguous: 0 });
      const stored = await storedFor(competition.id);
      expect(stored.matches).toHaveLength(1);
      expect(stored.sources).toEqual([...ids].sort());
      // Le combat garde la représentation retenue à la création (comportement historique).
      expect(stored.matches[0].source_external_id).toBe(ids[0]);
    });

    it("IDEMPOTENCE : relancer (avec ou sans refresh) ne crée aucun nouveau combat ni aucune nouvelle représentation", async () => {
      const { competition, slug } = await scenario("idem12b");
      const [alice, bruno] = [fixtureAthlete("Alice EXEMPLE", "FRA"), fixtureAthlete("Bruno TESTEUR", "KOR")];
      const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const options = { a: alice, b: bruno, scoreA: "2", scoreB: "0", winner: "A" as const, stage: "F", contestNumber: 1 };
      registerMatches(slug, ids.map((id) => ({ id, options })));
      await run({ slugs: [slug] });
      const before = await storedFor(competition.id);

      // Sans refresh : toutes les représentations sont déjà connues, aucune page match demandée.
      fake.calls = [];
      const second = await run({ slugs: [slug] });
      expect(second.competitions[0]).toMatchObject({ matchesSkippedExisting: 4, matchesCreated: 0, matchesAttached: 0, matchesConflicts: 0 });
      expect(fake.matchCalls()).toBe(0);

      // Avec refresh : les 4 pages sont relues, chacune reconnue comme représentation existante.
      const third = await run({ slugs: [slug], refreshExisting: true });
      expect(third.competitions[0]).toMatchObject({ matchesFetched: 4, matchesUpdated: 4, matchesCreated: 0, matchesAttached: 0, matchesConflicts: 0 });

      const after = await storedFor(competition.id);
      expect(after.matches).toHaveLength(before.matches.length);
      expect(after.sources).toEqual(before.sources);
      expect(after.matches.map((m) => m.id)).toEqual(before.matches.map((m) => m.id));
    });

    it("CONFLICT : même clé mais score/vainqueur divergent ⇒ NON fusionné, les deux combats et leurs identifiants conservés, anomalie explicite", async () => {
      const { competition, slug } = await scenario("conflict");
      const [alice, bruno] = [fixtureAthlete("Alice EXEMPLE", "FRA"), fixtureAthlete("Bruno TESTEUR", "KOR")];
      const [c1, c2] = [randomUUID(), randomUUID()];
      registerMatches(slug, [
        { id: c1, options: { a: alice, b: bruno, scoreA: "2", scoreB: "0", winner: "A", stage: "F", contestNumber: 1 } },
        { id: c2, options: { a: alice, b: bruno, scoreA: "0", scoreB: "2", winner: "B", stage: "F", contestNumber: 1 } },
      ]);

      const report = await run({ slugs: [slug] });

      expect(report.competitions[0]).toMatchObject({ matchesCreated: 1, matchesAttached: 0, matchesConflicts: 1 });
      expect(report.matches).toMatchObject({ conflicts: 1, sameLogicalFight: 0 });
      expect(report.anomalies.join("\n")).toMatch(new RegExp(`CONFLICT match ${c2}.*scoreA.*NON fusionné`));
      const stored = await storedFor(competition.id);
      expect(stored.matches).toHaveLength(2);
      expect(stored.sources).toEqual([c1, c2].sort());
      // Chaque combat conserve ses propres données, rien n'a été écrasé.
      const byId = new Map(stored.matches.map((m) => [m.source_external_id, m]));
      expect([byId.get(c1)!.score_a, byId.get(c1)!.score_b]).toEqual([2, 0]);
      expect([byId.get(c2)!.score_a, byId.get(c2)!.score_b]).toEqual([0, 2]);
    });

    it("CONFLICT : orientation A/B inversée (même paire, page source ordonnée autrement) ⇒ jamais fusionné silencieusement", async () => {
      const { competition, slug } = await scenario("swap");
      const [alice, bruno] = [fixtureAthlete("Alice EXEMPLE", "FRA"), fixtureAthlete("Bruno TESTEUR", "KOR")];
      const [s1, s2] = [randomUUID(), randomUUID()];
      registerMatches(slug, [
        { id: s1, options: { a: alice, b: bruno, scoreA: "2", scoreB: "0", winner: "A", stage: "F", contestNumber: 1 } },
        { id: s2, options: { a: bruno, b: alice, scoreA: "0", scoreB: "2", winner: "B", stage: "F", contestNumber: 1 } },
      ]);

      const report = await run({ slugs: [slug] });

      expect(report.matches.conflicts).toBe(1);
      expect(report.anomalies.join("\n")).toMatch(/orientation/);
      expect((await storedFor(competition.id)).matches).toHaveLength(2);
    });

    it("le conflit conservé est stable : relancer avec refresh ne fusionne rien et ne crée rien", async () => {
      const { competition, slug } = await scenario("conflict-idem");
      const [alice, bruno] = [fixtureAthlete("Alice EXEMPLE", "FRA"), fixtureAthlete("Bruno TESTEUR", "KOR")];
      registerMatches(slug, [
        { id: randomUUID(), options: { a: alice, b: bruno, scoreA: "2", scoreB: "0", winner: "A", stage: "F", contestNumber: 1 } },
        { id: randomUUID(), options: { a: alice, b: bruno, scoreA: "0", scoreB: "2", winner: "B", stage: "F", contestNumber: 1 } },
      ]);
      await run({ slugs: [slug] });
      const before = await storedFor(competition.id);

      const refreshed = await run({ slugs: [slug], refreshExisting: true });

      expect(refreshed.competitions[0]).toMatchObject({ matchesCreated: 0, matchesAttached: 0, matchesConflicts: 0 });
      const after = await storedFor(competition.id);
      expect(after.matches.map((m) => m.id)).toEqual(before.matches.map((m) => m.id));
      expect(after.sources).toEqual(before.sources);
    });

    it("clé différente ⇒ combats distincts : revanche (autre n° de combat), autre catégorie, autre paire", async () => {
      const { competition, slug } = await scenario("distinct");
      const [alice, bruno, carla] = [fixtureAthlete("Alice EXEMPLE", "FRA"), fixtureAthlete("Bruno TESTEUR", "KOR"), fixtureAthlete("Carla TEST", "ESP")];
      const base = { a: alice, b: bruno, scoreA: "2", scoreB: "0", winner: "A" as const, stage: "F" };
      registerMatches(slug, [
        { id: randomUUID(), options: { ...base, contestNumber: 1 } },
        { id: randomUUID(), options: { ...base, contestNumber: 2 } }, // même paire, autre n° : revanche
        { id: randomUUID(), options: { ...base, contestNumber: 1, category: "Men -80kg" } }, // autre catégorie
        { id: randomUUID(), options: { ...base, b: carla, contestNumber: 1 } }, // même n°, autre paire
      ]);

      const report = await run({ slugs: [slug] });

      expect(report.competitions[0]).toMatchObject({ matchesCreated: 4, matchesAttached: 0, matchesConflicts: 0 });
      expect((await storedFor(competition.id)).matches).toHaveLength(4);
    });

    it("clé indéterminée (catégorie ou n° de combat absent) ⇒ jamais de rapprochement, chaque représentation reste un combat", async () => {
      const { competition, slug } = await scenario("nokey");
      const [alice, bruno] = [fixtureAthlete("Alice EXEMPLE", "FRA"), fixtureAthlete("Bruno TESTEUR", "KOR")];
      const options = { a: alice, b: bruno, scoreA: "2", scoreB: "0", winner: "A" as const, stage: "F", contestNumber: null, category: null };
      registerMatches(slug, [
        { id: randomUUID(), options },
        { id: randomUUID(), options },
      ]);

      const report = await run({ slugs: [slug] });

      expect(report.competitions[0]).toMatchObject({ matchesCreated: 2, matchesAttached: 0 });
      expect((await storedFor(competition.id)).matches).toHaveLength(2);
    });

    it("anomalie de la source (victoire aux points avec score vainqueur non supérieur) : conservée telle quelle + rapportée", async () => {
      const { competition, slug } = await scenario("anomaly");
      const [alice, bruno] = [fixtureAthlete("Alice EXEMPLE", "FRA"), fixtureAthlete("Bruno TESTEUR", "KOR")];
      registerMatches(slug, [{ id: randomUUID(), options: { a: alice, b: bruno, scoreA: "1", scoreB: "2", winner: "A" } }]);

      const report = await run({ slugs: [slug] });

      expect(report.anomalies.join("\n")).toMatch(/PTF/);
      const stored = await prisma.competition_match.findFirstOrThrow({ where: { competition_id: competition.id } });
      expect([stored.score_a, stored.score_b]).toEqual([1, 2]);
      expect(stored.winner_athlete_id).toBe(stored.athlete_a_id);
    });
  });

  describe("politesse et garde-fous", () => {
    it("signal de blocage ⇒ import arrêté net, rapport partiel conservé, aucune exception, aucun match suivant demandé", async () => {
      const { competition, slug } = await scenario("blocked");
      const [alice, bruno] = [fixtureAthlete("Alice EXEMPLE", "FRA"), fixtureAthlete("Bruno TESTEUR", "KOR")];
      const [ok, blocked, never] = [randomUUID(), randomUUID(), randomUUID()];
      registerMatches(slug, [
        { id: ok, options: { a: alice, b: bruno } },
        { id: blocked, options: "blocked" },
        { id: never, options: { a: alice, b: bruno } },
      ]);

      const report = await run({ slugs: [slug] });

      expect(report.aborted).toMatch(/HTTP 403/);
      expect(report.competitions[0].matchesCreated).toBe(1);
      expect(await prisma.competition_match.count({ where: { competition_id: competition.id } })).toBe(1);
      expect(fake.calls).not.toContain(`match:${never}`);
    });

    it(`refuse plus de ${MAX_PILOT_COMPETITIONS} compétitions ou aucune`, async () => {
      await expect(run({ slugs: ["a", "b", "c", "d"] })).rejects.toThrow(/entre 1 et 3/);
      await expect(run({ slugs: [] })).rejects.toThrow(/entre 1 et 3/);
    });

    it("plafond de matchs par compétition respecté et rapporté", async () => {
      const { competition, slug } = await scenario("cap");
      const [alice, bruno] = [fixtureAthlete("Alice EXEMPLE", "FRA"), fixtureAthlete("Bruno TESTEUR", "KOR")];
      registerMatches(slug, [1, 2, 3].map((n) => ({ id: randomUUID(), options: { a: alice, b: bruno, contestNumber: n } })));

      const report = await run({ slugs: [slug], maxMatchesPerCompetition: 2 });

      expect(report.competitions[0]).toMatchObject({ matchesListed: 3, matchesCapped: 1, matchesCreated: 2 });
      expect(await prisma.competition_match.count({ where: { competition_id: competition.id } })).toBe(2);
    });

    it("catégorie : résolue par libellé (filtre natif ?event=) ; catégorie inconnue ⇒ note, aucun match", async () => {
      const { slug } = await scenario("category");
      const [alice, bruno] = [fixtureAthlete("Alice EXEMPLE", "FRA"), fixtureAthlete("Bruno TESTEUR", "KOR")];
      registerMatches(slug, [{ id: randomUUID(), options: { a: alice, b: bruno } }]);
      const eventId = fake.listings.get(slug)!.categories[0].eventId;

      await run({ slugs: [slug], categoryLabel: "men -68KG" });
      expect(fake.calls).toContain(`listing:${slug}:${eventId}`);

      const unknown = await run({ slugs: [slug], categoryLabel: "Women -49kg" });
      expect(unknown.competitions[0].notes.join(" ")).toMatch(/introuvable \(disponibles : Men -68kg\)/);
      expect(unknown.competitions[0].matchesCreated).toBe(0);
    });
  });

  describe("profils (record V/D affiché)", () => {
    it("relève le record source d'athlètes déjà importés (snapshot avec date) ; athlète inconnu ⇒ rapporté, jamais créé", async () => {
      const { slug } = await scenario("profile");
      const alice = fixtureAthlete("Alice EXEMPLE", "FRA");
      const bruno = fixtureAthlete("Bruno TESTEUR", "KOR");
      const stranger = fixtureAthlete("Inconnue", "THA"); // jamais importée
      registerMatches(slug, [{ id: randomUUID(), options: { a: alice, b: bruno } }]);
      fake.profiles.set(alice.id, { athlete: alice, record: "53 / 13 (80.3%)" });
      fake.profiles.set(stranger.id, { athlete: stranger, record: "1 / 1 (50.0%)" });

      const report = await run({ slugs: [slug], profileAthleteIds: [alice.id, stranger.id] });

      expect(report.profiles.updated).toBe(1);
      expect(report.profiles.failed).toEqual([{ athleteId: stranger.id, reason: expect.stringMatching(/inconnu en base/) }]);
      const row = await prisma.external_athlete_source.findUniqueOrThrow({
        where: { source_source_external_id: { source: "world_taekwondo_results", source_external_id: alice.id } },
      });
      expect([row.record_wins, row.record_losses]).toEqual([53, 13]);
      expect(row.record_synced_at).not.toBeNull();
      expect(await prisma.external_athlete_source.count({ where: { source_external_id: stranger.id } })).toBe(0);
    });
  });

  it("aucun impact : un import complet (initial + refresh) ne touche JAMAIS participation, competition_entry ni athlete EKVARA", async () => {
    const { slug } = await scenario("noimpact");
    const [alice, bruno] = [fixtureAthlete("Alice EXEMPLE", "FRA"), fixtureAthlete("Bruno TESTEUR", "KOR")];
    registerMatches(slug, [{ id: randomUUID(), options: { a: alice, b: bruno } }]);
    const rowsBefore = await snapshotRows(prisma);

    // Tout l'import passe par un client qui LÈVE au moindre accès à ces tables.
    const guardedService = new WtResultsImportService(
      fake as unknown as WorldTaekwondoResultsImporterService,
      new InternationalRepository(forbidTables(prisma, ["participation", "competition_entry", "athlete"])),
    );
    const first = await guardedService.runPilot({ year: 2033, slugs: [slug] });
    const second = await guardedService.runPilot({ year: 2033, slugs: [slug], refreshExisting: true });

    expect(first.competitions[0].matchesCreated).toBe(1);
    expect(second.competitions[0].matchesUpdated).toBe(1);
    expect(modifiedRows(rowsBefore, await snapshotRows(prisma))).toEqual([]);
  });
});
