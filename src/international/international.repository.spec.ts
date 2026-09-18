import "dotenv/config";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CompetitionSourceConflictError, InternationalRepository } from "./international.repository";
import { forbidTables, modifiedRows, snapshotRows, totalRows } from "./preexisting-rows.snapshot";
import { WT_RESULTS_SOURCE } from "./wt-results/wtr-parser";

// Intégration contre la vraie base Postgres locale (CLAUDE.md §23) : contraintes
// uniques, FK, CHECK et comportements d'upsert sont du vrai SQL qu'un mock ne
// peut pas valider. Toutes les lignes créées ici sont suffixées par runId et
// supprimées en afterEach (competition → cascade sur matchs/sources, puis
// external_athlete → cascade sur ses sources) : aucune donnée de dev existante
// n'est modifiée — ce que les tests "aucun impact" vérifient par hash.
describe("InternationalRepository (intégration Postgres)", () => {
  let prisma: PrismaService;
  let repository: InternationalRepository;
  const runId = Date.now();
  const competitionIds: string[] = [];
  let dayOffset = 0;

  beforeAll(() => {
    prisma = new PrismaService();
    repository = new InternationalRepository(prisma);
  }, 30000);

  afterEach(async () => {
    if (competitionIds.length > 0) {
      await prisma.competition.deleteMany({ where: { id: { in: competitionIds } } });
      competitionIds.length = 0;
    }
    await prisma.external_athlete.deleteMany({
      where: { sources: { some: { source_external_id: { startsWith: `test-${runId}-` } } } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  }, 30000);

  const ext = (label: string) => `test-${runId}-${label}`;

  async function canonicalCompetition(label: string, sources: { source: string; externalId: string }[] = []) {
    dayOffset++;
    const start = new Date(Date.UTC(2032, 0, dayOffset));
    const competition = await prisma.competition.create({
      data: {
        nom: `Compétition Test ${label} ${runId}`,
        date_debut: start,
        date_fin: new Date(Date.UTC(2032, 0, dayOffset + 2)),
        ville: "Testville",
        sources: {
          create: sources.map((s) => ({ source: s.source, source_external_id: s.externalId, raw_nom: `raw ${label}` })),
        },
      },
    });
    competitionIds.push(competition.id);
    return competition;
  }

  async function athlete(label: string, name = `Athlète ${label}`, noc: string | null = "FRA") {
    return repository.upsertAthleteFromSource({
      source: WT_RESULTS_SOURCE,
      sourceExternalId: ext(label),
      sourceUrl: `https://results.worldtaekwondo.org/profile/${ext(label)}`,
      displayName: name,
      countryCode: noc,
      imageUrl: `https://example.test/${label}.jpg`,
    });
  }

  describe("external_athlete + external_athlete_source", () => {
    it("1+2. crée un external_athlete et sa source WT Results (NOC conservé tel quel, gender/birth_date NULL)", async () => {
      const { athleteId, created } = await athlete("a1", "Alice Exemple", "FRA");
      expect(created).toBe(true);

      const stored = await prisma.external_athlete.findUniqueOrThrow({ where: { id: athleteId }, include: { sources: true } });
      expect(stored.display_name).toBe("Alice Exemple");
      expect(stored.country_code).toBe("FRA");
      expect(stored.gender).toBeNull();
      expect(stored.birth_date).toBeNull();
      expect(stored.sources).toHaveLength(1);
      expect(stored.sources[0]).toMatchObject({
        source: "world_taekwondo_results",
        source_external_id: ext("a1"),
        raw_name: "Alice Exemple",
        image_url: `https://example.test/a1.jpg`,
        record_wins: null,
      });
    });

    it("3. le même UUID source revu ⇒ le MÊME external_athlete (aucun doublon d'athlète ni de source)", async () => {
      const first = await athlete("same-uuid", "Nom Un");
      const second = await athlete("same-uuid", "Nom Un");
      const third = await athlete("same-uuid", "Nom Un");

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(third.athleteId).toBe(first.athleteId);
      expect(await prisma.external_athlete_source.count({ where: { source_external_id: ext("same-uuid") } })).toBe(1);
      expect(await prisma.external_athlete.count({ where: { sources: { some: { source_external_id: ext("same-uuid") } } } })).toBe(1);
    });

    it("4. deux UUID différents portant le MÊME nom ⇒ deux athlètes distincts (jamais dédupliqués par nom)", async () => {
      const one = await athlete("homonym-1", "Kim MIN-JUN", "KOR");
      const two = await athlete("homonym-2", "Kim MIN-JUN", "KOR");

      expect(one.athleteId).not.toBe(two.athleteId);
      expect(one.created && two.created).toBe(true);
    });

    it("un UUID revu comble un NOC manquant mais n'écrase jamais un NOC déjà renseigné ; raw_name reflète la dernière valeur source", async () => {
      const first = await athlete("noc", "Nom V1", null);
      await athlete("noc", "Nom V2", "THA");
      await athlete("noc", "Nom V3", "FRA");

      const stored = await prisma.external_athlete.findUniqueOrThrow({ where: { id: first.athleteId }, include: { sources: true } });
      expect(stored.country_code).toBe("THA");
      expect(stored.display_name).toBe("Nom V1");
      expect(stored.sources[0].raw_name).toBe("Nom V3");
    });

    it("contrainte unique (source, source_external_id) réellement appliquée par Postgres", async () => {
      const { athleteId } = await athlete("unique-src");
      await expect(
        prisma.external_athlete_source.create({
          data: { external_athlete_id: athleteId, source: WT_RESULTS_SOURCE, source_external_id: ext("unique-src") },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("une même source_external_id sous une AUTRE source est une identité distincte (architecture multi-sources)", async () => {
      const wt = await athlete("multi");
      const other = await repository.upsertAthleteFromSource({
        source: "autre_source_test",
        sourceExternalId: ext("multi"),
        displayName: "Autre",
      });
      expect(other.created).toBe(true);
      expect(other.athleteId).not.toBe(wt.athleteId);
    });

    it("saveRecordSnapshot : enregistre le record affiché avec sa date de relevé ; false si la source est inconnue", async () => {
      await athlete("record");
      const syncedAt = new Date("2026-09-19T10:00:00Z");
      expect(await repository.saveRecordSnapshot(WT_RESULTS_SOURCE, ext("record"), { recordWins: 53, recordLosses: 13, syncedAt })).toBe(true);
      expect(await repository.saveRecordSnapshot(WT_RESULTS_SOURCE, ext("nope"), { recordWins: 1, recordLosses: 1, syncedAt })).toBe(false);

      const row = await prisma.external_athlete_source.findUniqueOrThrow({
        where: { source_source_external_id: { source: WT_RESULTS_SOURCE, source_external_id: ext("record") } },
      });
      expect([row.record_wins, row.record_losses]).toEqual([53, 13]);
      expect(row.record_synced_at?.toISOString()).toBe(syncedAt.toISOString());
    });
  });

  describe("competition_match", () => {
    async function twoAthletes() {
      const a = await athlete(`m-a-${dayOffset}-${Math.random().toString(36).slice(2, 6)}`, "Combattant A", "FRA");
      const b = await athlete(`m-b-${dayOffset}-${Math.random().toString(36).slice(2, 6)}`, "Combattant B", "KOR");
      return { a: a.athleteId, b: b.athleteId };
    }

    it("5+6. un match référence deux external_athlete ET la competition CANONIQUE (jamais un id de source)", async () => {
      const competition = await canonicalCompetition("fk");
      const { a, b } = await twoAthletes();

      const { matchId, created } = await repository.upsertMatch({
        competitionId: competition.id,
        source: WT_RESULTS_SOURCE,
        sourceExternalId: ext("match-fk"),
        sourceUrl: "https://results.worldtaekwondo.org/x",
        categoryLabel: "Men -68kg",
        bracketStage: "QF",
        contestNumber: 12,
        athleteAId: a,
        athleteBId: b,
        scoreA: 0,
        scoreB: 2,
        winnerAthleteId: b,
        resultMethod: "PTF",
        resultMethodRaw: "Won by PTF",
      });
      expect(created).toBe(true);

      const stored = await prisma.competition_match.findUniqueOrThrow({
        where: { id: matchId },
        include: { athlete_a: true, athlete_b: true, winner: true, competition: true },
      });
      expect(stored.competition.id).toBe(competition.id);
      expect(stored.athlete_a.display_name).toBe("Combattant A");
      expect(stored.athlete_b.country_code).toBe("KOR");
      expect(stored.winner?.id).toBe(b);
      // score 0 est une valeur valide (jamais confondue avec "absent")
      expect([stored.score_a, stored.score_b]).toEqual([0, 2]);
      expect([stored.category_label, stored.bracket_stage, stored.contest_number]).toEqual(["Men -68kg", "QF", 12]);
    });

    it("7. idempotence : upsert du même match source ⇒ une seule ligne, mise à jour", async () => {
      const competition = await canonicalCompetition("idem");
      const { a, b } = await twoAthletes();
      const base = {
        competitionId: competition.id,
        source: WT_RESULTS_SOURCE,
        sourceExternalId: ext("match-idem"),
        athleteAId: a,
        athleteBId: b,
      };

      const first = await repository.upsertMatch({ ...base, scoreA: 1, scoreB: 2 });
      const second = await repository.upsertMatch({ ...base, scoreA: 2, scoreB: 1, winnerAthleteId: a });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.matchId).toBe(first.matchId);
      expect(await prisma.competition_match.count({ where: { source_external_id: ext("match-idem") } })).toBe(1);
      const stored = await prisma.competition_match.findUniqueOrThrow({ where: { id: first.matchId } });
      expect([stored.score_a, stored.score_b, stored.winner_athlete_id]).toEqual([2, 1, a]);
    });

    it("8. contrainte unique (source, source_external_id) sur le match réellement appliquée par Postgres", async () => {
      const competition = await canonicalCompetition("uniq-match");
      const { a, b } = await twoAthletes();
      const data = {
        competition_id: competition.id,
        source: WT_RESULTS_SOURCE,
        source_external_id: ext("match-uniq"),
        athlete_a_id: a,
        athlete_b_id: b,
      };
      await prisma.competition_match.create({ data });
      await expect(prisma.competition_match.create({ data })).rejects.toMatchObject({ code: "P2002" });
    });

    it("CHECK Postgres : un combat ne peut pas opposer un athlète à lui-même", async () => {
      const competition = await canonicalCompetition("check-self");
      const { a } = await twoAthletes();
      await expect(
        prisma.competition_match.create({
          data: { competition_id: competition.id, source: WT_RESULTS_SOURCE, source_external_id: ext("self"), athlete_a_id: a, athlete_b_id: a },
        }),
      ).rejects.toThrow(/competition_match_distinct_athletes_check|check constraint/i);
    });

    it("CHECK Postgres : le vainqueur doit être l'un des deux combattants", async () => {
      const competition = await canonicalCompetition("check-winner");
      const { a, b } = await twoAthletes();
      const stranger = await athlete(`stranger-${Math.random().toString(36).slice(2, 6)}`);
      await expect(
        prisma.competition_match.create({
          data: {
            competition_id: competition.id,
            source: WT_RESULTS_SOURCE,
            source_external_id: ext("bad-winner"),
            athlete_a_id: a,
            athlete_b_id: b,
            winner_athlete_id: stranger.athleteId,
          },
        }),
      ).rejects.toThrow(/competition_match_winner_is_participant_check|check constraint/i);
    });

    it("tolère les données manquantes : ni score, ni vainqueur, ni méthode, ni catégorie, ni stade", async () => {
      const competition = await canonicalCompetition("sparse");
      const { a, b } = await twoAthletes();
      const { matchId } = await repository.upsertMatch({
        competitionId: competition.id,
        source: WT_RESULTS_SOURCE,
        sourceExternalId: ext("sparse"),
        athleteAId: a,
        athleteBId: b,
      });
      const stored = await prisma.competition_match.findUniqueOrThrow({ where: { id: matchId } });
      expect([stored.score_a, stored.score_b, stored.winner_athlete_id, stored.result_method, stored.category_label, stored.bracket_stage, stored.occurred_at]).toEqual([
        null, null, null, null, null, null, null,
      ]);
    });

    it("supprimer la competition supprime ses matchs (cascade) sans supprimer les athlètes externes", async () => {
      const competition = await canonicalCompetition("cascade");
      const { a, b } = await twoAthletes();
      await repository.upsertMatch({ competitionId: competition.id, source: WT_RESULTS_SOURCE, sourceExternalId: ext("cascade"), athleteAId: a, athleteBId: b });

      await prisma.competition.delete({ where: { id: competition.id } });
      competitionIds.length = 0;

      expect(await prisma.competition_match.count({ where: { source_external_id: ext("cascade") } })).toBe(0);
      expect(await prisma.external_athlete.count({ where: { id: { in: [a, b] } } })).toBe(2);
    });

    it("un athlète externe référencé par un match ne peut pas être supprimé (FK sans cascade)", async () => {
      const competition = await canonicalCompetition("restrict");
      const { a, b } = await twoAthletes();
      await repository.upsertMatch({ competitionId: competition.id, source: WT_RESULTS_SOURCE, sourceExternalId: ext("restrict"), athleteAId: a, athleteBId: b });
      await expect(prisma.external_athlete.delete({ where: { id: a } })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });

    it("findExistingMatchIds / pagination par athlète et par compétition (contest_number croissant, NULL en dernier)", async () => {
      const competition = await canonicalCompetition("list");
      const { a, b } = await twoAthletes();
      const c = (await athlete(`list-c-${Math.random().toString(36).slice(2, 6)}`)).athleteId;
      const mk = (label: string, contest: number | null, x: string, y: string) =>
        repository.upsertMatch({ competitionId: competition.id, source: WT_RESULTS_SOURCE, sourceExternalId: ext(label), contestNumber: contest, athleteAId: x, athleteBId: y });
      await mk("l3", null, a, b);
      await mk("l2", 20, b, a);
      await mk("l1", 10, a, c);
      await mk("l4", 30, b, c);

      const existing = await repository.findExistingMatchIds(WT_RESULTS_SOURCE, [ext("l1"), ext("l4"), ext("absent")]);
      expect([...existing].sort()).toEqual([ext("l1"), ext("l4")].sort());

      const forAthlete = await repository.findMatchesByAthlete(a, 1, 10);
      expect(forAthlete.total).toBe(3);
      expect(forAthlete.items.map((m) => m.contest_number)).toEqual([10, 20, null]);

      const page2 = await repository.findMatchesByCompetition(competition.id, 2, 3);
      expect(page2.total).toBe(4);
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0].contest_number).toBeNull();
    });
  });

  describe("rattachement d'une source Results à la competition canonique", () => {
    it("9. crée UNE competition_source world_taekwondo_results (match_confidence safe) sur la MÊME competition que la source calendrier", async () => {
      const competition = await canonicalCompetition("attach", [{ source: "world_taekwondo", externalId: ext("cal-25980") }]);

      const outcome = await repository.attachResultsSource({
        competitionId: competition.id,
        source: WT_RESULTS_SOURCE,
        sourceExternalId: ext("slug-attach"),
        sourceUrl: "https://results.worldtaekwondo.org/competitions/x/results",
        rawName: "Nom Results",
      });
      expect(outcome).toBe("attached");

      const sources = await prisma.competition_source.findMany({ where: { competition_id: competition.id }, orderBy: { created_at: "asc" } });
      expect(sources.map((s) => [s.source, s.source_external_id])).toEqual([
        ["world_taekwondo", ext("cal-25980")],
        ["world_taekwondo_results", ext("slug-attach")],
      ]);
      expect(sources[1].match_confidence).toBe("safe");
      expect(sources[1].raw_nom).toBe("Nom Results");
    });

    it("ré-attacher le même slug à la même competition ⇒ refreshed, aucune ligne en plus", async () => {
      const competition = await canonicalCompetition("reattach", [{ source: "world_taekwondo", externalId: ext("cal-r") }]);
      const input = { competitionId: competition.id, source: WT_RESULTS_SOURCE, sourceExternalId: ext("slug-r"), sourceUrl: "u1", rawName: "n1" };

      expect(await repository.attachResultsSource(input)).toBe("attached");
      expect(await repository.attachResultsSource({ ...input, sourceUrl: "u2", rawName: "n2" })).toBe("refreshed");
      expect(await prisma.competition_source.count({ where: { source: WT_RESULTS_SOURCE, source_external_id: ext("slug-r") } })).toBe(1);
    });

    it("refuse de déplacer un slug déjà rattaché à une AUTRE competition (aucune modification)", async () => {
      const first = await canonicalCompetition("conflict-1", [{ source: "world_taekwondo", externalId: ext("cal-c1") }]);
      const second = await canonicalCompetition("conflict-2", [{ source: "world_taekwondo", externalId: ext("cal-c2") }]);
      const base = { source: WT_RESULTS_SOURCE, sourceExternalId: ext("slug-conflict"), sourceUrl: "u", rawName: "n" };

      await repository.attachResultsSource({ ...base, competitionId: first.id });
      await expect(repository.attachResultsSource({ ...base, competitionId: second.id })).rejects.toBeInstanceOf(CompetitionSourceConflictError);

      const row = await prisma.competition_source.findUniqueOrThrow({
        where: { source_source_external_id: { source: WT_RESULTS_SOURCE, source_external_id: ext("slug-conflict") } },
      });
      expect(row.competition_id).toBe(first.id);
    });

    it("findCalendarCandidates : seulement les competitions connues du calendrier WT commençant ce jour-là", async () => {
      const wt = await canonicalCompetition("cand-wt", [{ source: "world_taekwondo", externalId: ext("cal-cand") }]);
      // Même jour, mais SANS source calendrier WT (ex. FFTDA) : jamais candidate.
      const sameDayOther = await prisma.competition.create({
        data: { nom: `Autre ${runId}`, date_debut: wt.date_debut, sources: { create: { source: "fftda", source_external_id: ext("fftda-cand") } } },
      });
      competitionIds.push(sameDayOther.id);

      const candidates = await repository.findCalendarCandidates(wt.date_debut);
      const mine = candidates.filter((c) => c.competitionId === wt.id || c.competitionId === sameDayOther.id);
      expect(mine.map((c) => c.competitionId)).toEqual([wt.id]);
      expect(mine[0].calendarExternalIds).toEqual([ext("cal-cand")]);
      expect(mine[0].dateFin?.toISOString().slice(0, 10)).toBe(wt.date_fin?.toISOString().slice(0, 10));
    });
  });

  describe("aucun impact sur l'existant", () => {
    it("10-12. ré-attacher + importer des athlètes/matchs ne modifie NI la competition canonique, NI sa source calendrier ; participation, competition_entry et athlete ne sont JAMAIS touchés", async () => {
      const competition = await canonicalCompetition("noimpact", [{ source: "world_taekwondo", externalId: ext("cal-noimpact") }]);
      const readCompetition = async () => ({
        competition: JSON.stringify(await prisma.competition.findUniqueOrThrow({ where: { id: competition.id } })),
        calendarSource: JSON.stringify(
          await prisma.competition_source.findFirstOrThrow({ where: { competition_id: competition.id, source: "world_taekwondo" } }),
        ),
      });
      const before = await readCompetition();
      const rowsBefore = await snapshotRows(prisma);
      expect(totalRows(rowsBefore)).toBeGreaterThan(0); // le test a des données réelles à protéger

      // Le repository testé reçoit un client qui LÈVE dès qu'on touche ces tables.
      const guarded = new InternationalRepository(forbidTables(prisma, ["participation", "competition_entry", "athlete"]));
      await guarded.attachResultsSource({
        competitionId: competition.id,
        source: WT_RESULTS_SOURCE,
        sourceExternalId: ext("slug-noimpact"),
        sourceUrl: "u",
        rawName: "Nom différent du canonique",
      });
      const a = (await guarded.upsertAthleteFromSource({ source: WT_RESULTS_SOURCE, sourceExternalId: ext("ni-a"), displayName: "NI A" })).athleteId;
      const b = (await guarded.upsertAthleteFromSource({ source: WT_RESULTS_SOURCE, sourceExternalId: ext("ni-b"), displayName: "NI B" })).athleteId;
      await guarded.upsertMatch({ competitionId: competition.id, source: WT_RESULTS_SOURCE, sourceExternalId: ext("ni-m"), athleteAId: a, athleteBId: b });
      await guarded.findMatchesByCompetition(competition.id, 1, 10);
      await guarded.findCalendarCandidates(competition.date_debut);

      expect(await readCompetition()).toEqual(before);
      expect(modifiedRows(rowsBefore, await snapshotRows(prisma))).toEqual([]);
    });

    it("le garde-fou fonctionne : un accès à une table interdite lève réellement", () => {
      const guarded = forbidTables(prisma, ["participation", "competition_entry", "athlete"]);
      expect(() => guarded.participation).toThrow(/Accès interdit/);
      expect(() => guarded.competition_entry).toThrow(/Accès interdit/);
      expect(() => guarded.athlete).toThrow(/Accès interdit/);
      expect(() => guarded.competition).not.toThrow();
    });
  });
});
