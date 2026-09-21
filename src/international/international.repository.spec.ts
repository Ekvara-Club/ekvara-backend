import "dotenv/config";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CompetitionSourceConflictError, InternationalRepository, MatchSaveResult } from "./international.repository";
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

      const { matchId, created } = await repository.saveMatchRepresentation({
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

      const first = await repository.saveMatchRepresentation({ ...base, scoreA: 1, scoreB: 2 });
      const second = await repository.saveMatchRepresentation({ ...base, scoreA: 2, scoreB: 1, winnerAthleteId: a });

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
      const { matchId } = await repository.saveMatchRepresentation({
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
      await repository.saveMatchRepresentation({ competitionId: competition.id, source: WT_RESULTS_SOURCE, sourceExternalId: ext("cascade"), athleteAId: a, athleteBId: b });

      await prisma.competition.delete({ where: { id: competition.id } });
      competitionIds.length = 0;

      expect(await prisma.competition_match.count({ where: { source_external_id: ext("cascade") } })).toBe(0);
      expect(await prisma.external_athlete.count({ where: { id: { in: [a, b] } } })).toBe(2);
    });

    it("un athlète externe référencé par un match ne peut pas être supprimé (FK sans cascade)", async () => {
      const competition = await canonicalCompetition("restrict");
      const { a, b } = await twoAthletes();
      await repository.saveMatchRepresentation({ competitionId: competition.id, source: WT_RESULTS_SOURCE, sourceExternalId: ext("restrict"), athleteAId: a, athleteBId: b });
      await expect(prisma.external_athlete.delete({ where: { id: a } })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });

    // --- Ticket #12B : représentations source et rapprochement conservateur ---------

    const keyed = (competitionId: string, id: string, a: string, b: string, overrides: Record<string, unknown> = {}) => ({
      competitionId,
      source: WT_RESULTS_SOURCE,
      sourceExternalId: ext(id),
      sourceUrl: `https://results.worldtaekwondo.org/x/${ext(id)}`,
      categoryLabel: "Men -68kg",
      bracketStage: "R32",
      contestNumber: 101,
      athleteAId: a,
      athleteBId: b,
      scoreA: 0,
      scoreB: 2,
      winnerAthleteId: b,
      resultMethod: "PTF",
      ...overrides,
    });

    it("SAME_LOGICAL_FIGHT : 4 représentations identiques ⇒ 1 competition_match + 4 competition_match_source, rien de créé pour les copies", async () => {
      const competition = await canonicalCompetition("same4");
      const { a, b } = await twoAthletes();

      const results: MatchSaveResult[] = [];
      for (const label of ["c1", "c2", "c3", "c4"]) {
        results.push(await repository.saveMatchRepresentation(keyed(competition.id, label, a, b)));
      }

      expect(results.map((r) => r.outcome)).toEqual(["created", "attached", "attached", "attached"]);
      expect(results.map((r) => r.created)).toEqual([true, false, false, false]);
      expect(new Set(results.map((r) => r.matchId)).size).toBe(1);
      expect(await prisma.competition_match.count({ where: { competition_id: competition.id } })).toBe(1);
      const sources = await prisma.competition_match_source.findMany({ where: { competition_match_id: results[0].matchId } });
      expect(sources.map((s) => s.source_external_id).sort()).toEqual(["c1", "c2", "c3", "c4"].map(ext).sort());
      // Les copies ne modifient PAS les données du combat retenu.
      const stored = await prisma.competition_match.findUniqueOrThrow({ where: { id: results[0].matchId } });
      expect(stored.source_external_id).toBe(ext("c1"));
    });

    it("le rapprochement ignore l'ordre des athlètes dans la clé (paire NON ordonnée) mais pas l'orientation : inversée ⇒ CONFLICT", async () => {
      const competition = await canonicalCompetition("swap");
      const { a, b } = await twoAthletes();
      await repository.saveMatchRepresentation(keyed(competition.id, "orig", a, b));

      const swapped = await repository.saveMatchRepresentation(
        keyed(competition.id, "swapped", b, a, { scoreA: 2, scoreB: 0, winnerAthleteId: b }),
      );

      expect(swapped.outcome).toBe("conflict");
      expect(swapped.differences).toContain("orientation");
      expect(swapped.created).toBe(true);
      expect(await prisma.competition_match.count({ where: { competition_id: competition.id } })).toBe(2);
    });

    it("CONFLICT : attribut critique divergent ⇒ nouveau combat conservé, l'existant intact, différences et ids liés rapportés", async () => {
      const competition = await canonicalCompetition("conflict");
      const { a, b } = await twoAthletes();
      const first = await repository.saveMatchRepresentation(keyed(competition.id, "orig", a, b));

      const conflict = await repository.saveMatchRepresentation(keyed(competition.id, "diff", a, b, { scoreA: 1, resultMethod: "PTG" }));

      expect(conflict).toMatchObject({ outcome: "conflict", created: true, relatedMatchIds: [first.matchId] });
      expect(conflict.differences.sort()).toEqual(["method", "scoreA"]);
      const original = await prisma.competition_match.findUniqueOrThrow({ where: { id: first.matchId }, include: { sources: true } });
      expect([original.score_a, original.result_method]).toEqual([0, "PTF"]);
      expect(original.sources).toHaveLength(1);
    });

    it("AMBIGUOUS : plusieurs combats existants cohérents ⇒ aucun choix arbitraire, représentation conservée à part", async () => {
      const competition = await canonicalCompetition("ambiguous");
      const { a, b } = await twoAthletes();
      // Deux combats déjà identiques non fusionnés (état hérité d'avant le rapprochement).
      const base = { competition_id: competition.id, category_label: "Men -68kg", bracket_stage: "R32", contest_number: 101, athlete_a_id: a, athlete_b_id: b, score_a: 0, score_b: 2, winner_athlete_id: b, result_method: "PTF" };
      const [m1, m2] = await Promise.all(
        ["x1", "x2"].map((label) =>
          prisma.competition_match.create({
            data: { ...base, source: WT_RESULTS_SOURCE, source_external_id: ext(label), sources: { create: { source: WT_RESULTS_SOURCE, source_external_id: ext(label) } } },
          }),
        ),
      );

      const result = await repository.saveMatchRepresentation(keyed(competition.id, "incoming", a, b));

      expect(result.outcome).toBe("ambiguous");
      expect(result.created).toBe(true);
      expect(result.relatedMatchIds.sort()).toEqual([m1.id, m2.id].sort());
      expect(await prisma.competition_match.count({ where: { competition_id: competition.id } })).toBe(3);
    });

    it("clé indéterminée (catégorie ou n° de combat NULL) ⇒ jamais de rapprochement ; n° 0 est un numéro valide", async () => {
      const competition = await canonicalCompetition("nokey");
      const { a, b } = await twoAthletes();

      const noCategory = [
        await repository.saveMatchRepresentation(keyed(competition.id, "n1", a, b, { categoryLabel: null })),
        await repository.saveMatchRepresentation(keyed(competition.id, "n2", a, b, { categoryLabel: null })),
      ];
      const noContest = [
        await repository.saveMatchRepresentation(keyed(competition.id, "k1", a, b, { contestNumber: null })),
        await repository.saveMatchRepresentation(keyed(competition.id, "k2", a, b, { contestNumber: null })),
      ];
      expect([...noCategory, ...noContest].map((r) => r.outcome)).toEqual(["created", "created", "created", "created"]);

      const zero = [
        await repository.saveMatchRepresentation(keyed(competition.id, "z1", a, b, { contestNumber: 0 })),
        await repository.saveMatchRepresentation(keyed(competition.id, "z2", a, b, { contestNumber: 0 })),
      ];
      expect(zero.map((r) => r.outcome)).toEqual(["created", "attached"]);
    });

    it("clé différente ⇒ combats distincts (autre compétition, autre catégorie, autre n°, autre paire)", async () => {
      const competition = await canonicalCompetition("distinct-1");
      const other = await canonicalCompetition("distinct-2");
      const { a, b } = await twoAthletes();
      const c = (await athlete(`d-c-${Math.random().toString(36).slice(2, 6)}`)).athleteId;
      await repository.saveMatchRepresentation(keyed(competition.id, "base", a, b));

      const outcomes = [
        (await repository.saveMatchRepresentation(keyed(other.id, "o1", a, b))).outcome,
        (await repository.saveMatchRepresentation(keyed(competition.id, "o2", a, b, { categoryLabel: "Men -80kg" }))).outcome,
        (await repository.saveMatchRepresentation(keyed(competition.id, "o3", a, b, { contestNumber: 102 }))).outcome,
        (await repository.saveMatchRepresentation(keyed(competition.id, "o4", a, c))).outcome,
      ];

      expect(outcomes).toEqual(["created", "created", "created", "created"]);
    });

    it("représentation déjà connue ⇒ refreshed, aucune ligne créée ; sur un combat à une seule représentation, la source peut le corriger", async () => {
      const competition = await canonicalCompetition("refresh-single");
      const { a, b } = await twoAthletes();
      const first = await repository.saveMatchRepresentation(keyed(competition.id, "r1", a, b));

      const again = await repository.saveMatchRepresentation(keyed(competition.id, "r1", a, b, { scoreA: 1, scoreB: 2 }));

      expect(again).toMatchObject({ outcome: "refreshed", created: false, matchId: first.matchId });
      const stored = await prisma.competition_match.findUniqueOrThrow({ where: { id: first.matchId } });
      expect([stored.score_a, stored.score_b]).toEqual([1, 2]);
    });

    it("refresh DIVERGENT d'une représentation d'un combat à plusieurs représentations ⇒ conflict, le combat n'est pas écrasé", async () => {
      const competition = await canonicalCompetition("refresh-multi");
      const { a, b } = await twoAthletes();
      const first = await repository.saveMatchRepresentation(keyed(competition.id, "m1", a, b));
      await repository.saveMatchRepresentation(keyed(competition.id, "m2", a, b));

      const diverging = await repository.saveMatchRepresentation(keyed(competition.id, "m2", a, b, { scoreA: 2, scoreB: 0, winnerAthleteId: a }));

      expect(diverging).toMatchObject({ outcome: "conflict", created: false, matchId: first.matchId });
      expect(diverging.differences).toEqual(expect.arrayContaining(["scoreA", "scoreB", "winner"]));
      const stored = await prisma.competition_match.findUniqueOrThrow({ where: { id: first.matchId } });
      expect([stored.score_a, stored.score_b, stored.winner_athlete_id]).toEqual([0, 2, b]);
    });

    it("idempotence : rejouer toutes les représentations ne change ni le nombre de combats ni celui des représentations", async () => {
      const competition = await canonicalCompetition("replay");
      const { a, b } = await twoAthletes();
      const labels = ["p1", "p2", "p3"];
      for (const label of labels) await repository.saveMatchRepresentation(keyed(competition.id, label, a, b));
      const snapshot = async () => ({
        matches: await prisma.competition_match.count({ where: { competition_id: competition.id } }),
        sources: await prisma.competition_match_source.count({ where: { competition_match: { competition_id: competition.id } } }),
      });
      const before = await snapshot();

      const replay: string[] = [];
      for (const label of labels) replay.push((await repository.saveMatchRepresentation(keyed(competition.id, label, a, b))).outcome);

      expect(replay).toEqual(["refreshed", "refreshed", "refreshed"]);
      expect(await snapshot()).toEqual(before);
    });

    it("course concurrente sur la MÊME représentation ⇒ une seule ligne de provenance, aucune erreur", async () => {
      const competition = await canonicalCompetition("race");
      const { a, b } = await twoAthletes();

      const results = await Promise.all([1, 2, 3].map(() => repository.saveMatchRepresentation(keyed(competition.id, "race", a, b))));

      expect(new Set(results.map((r) => r.matchId)).size).toBe(1);
      expect(await prisma.competition_match.count({ where: { competition_id: competition.id } })).toBe(1);
      expect(await prisma.competition_match_source.count({ where: { source_external_id: ext("race") } })).toBe(1);
    });

    it("ligne héritée : un competition_match sans ligne de provenance est reconnu et sa provenance rétablie (pas de doublon)", async () => {
      const competition = await canonicalCompetition("legacy");
      const { a, b } = await twoAthletes();
      await prisma.competition_match.create({
        data: { competition_id: competition.id, source: WT_RESULTS_SOURCE, source_external_id: ext("legacy"), category_label: "Men -68kg", contest_number: 101, athlete_a_id: a, athlete_b_id: b },
      });

      const result = await repository.saveMatchRepresentation(keyed(competition.id, "legacy", a, b));

      expect(result.outcome).toBe("refreshed");
      expect(await prisma.competition_match.count({ where: { competition_id: competition.id } })).toBe(1);
      expect(await prisma.competition_match_source.count({ where: { source_external_id: ext("legacy") } })).toBe(1);
    });

    it("competition_match_source : unique (source, source_external_id) appliqué par Postgres ; cascade avec le combat ; findExistingMatchIds voit aussi les représentations rattachées", async () => {
      const competition = await canonicalCompetition("source-table");
      const { a, b } = await twoAthletes();
      const first = await repository.saveMatchRepresentation(keyed(competition.id, "s1", a, b));
      await repository.saveMatchRepresentation(keyed(competition.id, "s2", a, b)); // rattachée, jamais représentation principale

      await expect(
        prisma.competition_match_source.create({ data: { competition_match_id: first.matchId, source: WT_RESULTS_SOURCE, source_external_id: ext("s2") } }),
      ).rejects.toMatchObject({ code: "P2002" });

      const known = await repository.findExistingMatchIds(WT_RESULTS_SOURCE, [ext("s1"), ext("s2"), ext("absent")]);
      expect([...known].sort()).toEqual([ext("s1"), ext("s2")].sort());

      await prisma.competition_match.delete({ where: { id: first.matchId } });
      expect(await prisma.competition_match_source.count({ where: { source_external_id: { in: [ext("s1"), ext("s2")] } } })).toBe(0);
    });

    it("le combat expose TOUTES ses représentations dans la lecture paginée (une ligne par combat, pas par représentation)", async () => {
      const competition = await canonicalCompetition("read-sources");
      const { a, b } = await twoAthletes();
      for (const label of ["v1", "v2", "v3", "v4"]) await repository.saveMatchRepresentation(keyed(competition.id, label, a, b));

      const page = await repository.findMatchesByCompetition(competition.id, 1, 20);

      expect(page.total).toBe(1);
      expect(page.items[0].sources.map((s) => s.source_external_id)).toEqual(["v1", "v2", "v3", "v4"].map(ext));
    });

    it("findExistingMatchIds / pagination par athlète et par compétition (contest_number croissant, NULL en dernier)", async () => {
      const competition = await canonicalCompetition("list");
      const { a, b } = await twoAthletes();
      const c = (await athlete(`list-c-${Math.random().toString(36).slice(2, 6)}`)).athleteId;
      const mk = (label: string, contest: number | null, x: string, y: string) =>
        repository.saveMatchRepresentation({ competitionId: competition.id, source: WT_RESULTS_SOURCE, sourceExternalId: ext(label), contestNumber: contest, athleteAId: x, athleteBId: y });
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
      await guarded.saveMatchRepresentation({ competitionId: competition.id, source: WT_RESULTS_SOURCE, sourceExternalId: ext("ni-m"), athleteAId: a, athleteBId: b });
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
