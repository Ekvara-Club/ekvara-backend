import { detectDuplicateEntries, entryOrigin, ExistingEntry } from "../entries/admin-entry-rules";
import { analyseMatchDuplicates, ExistingMatchFacts, matchOrigin } from "./admin-match-rules";

const A = "a";
const B = "b";
const C = "c";

function facts(id: string, extra: Partial<ExistingMatchFacts> = {}): ExistingMatchFacts {
  return { id, athleteAId: A, athleteBId: B, scoreA: 2, scoreB: 1, winnerAthleteId: A, resultMethod: "PTF", bracketStage: "F", ...extra };
}
const input = (extra: Partial<ExistingMatchFacts> = {}) => {
  const { id: _id, ...rest } = facts("input", extra);
  void _id;
  return rest;
};

describe("analyseMatchDuplicates (règle de rapprochement de l'import WT réutilisée)", () => {
  it("même clé logique et mêmes faits -> identical (création refusée)", () => {
    expect(analyseMatchDuplicates(input(), [facts("m1")], [facts("m1")])).toEqual([{ id: "m1", level: "identical", differences: [] }]);
  });

  it("même clé, paire en ordre inverse -> conflit d'orientation, jamais fusionné", () => {
    const swapped = facts("m1", { athleteAId: B, athleteBId: A, scoreA: 1, scoreB: 2 });
    expect(analyseMatchDuplicates(input(), [swapped], [swapped])).toEqual([
      { id: "m1", level: "conflict", differences: expect.arrayContaining(["orientation", "scoreA", "scoreB"]) },
    ]);
  });

  it("même clé, score ou vainqueur différent -> conflict avec les différences nommées", () => {
    const other = facts("m1", { scoreA: 3, winnerAthleteId: B });
    expect(analyseMatchDuplicates(input(), [other], [other])).toEqual([{ id: "m1", level: "conflict", differences: ["scoreA", "winner"] }]);
  });

  it("même paire ailleurs dans la compétition (autre clé) -> possible", () => {
    expect(analyseMatchDuplicates(input(), [], [facts("m2", { bracketStage: "QF" })])).toEqual([
      { id: "m2", level: "possible", differences: ["bracketStage"] },
    ]);
  });

  it("aucune correspondance -> aucun candidat", () => {
    expect(analyseMatchDuplicates(input({ athleteBId: C }), [], [])).toEqual([]);
  });
});

describe("origines", () => {
  it("combat : manuel seulement si toutes les représentations sont ekvara_manual", () => {
    expect(matchOrigin([{ source: "ekvara_manual" }])).toBe("manual");
    expect(matchOrigin([{ source: "ekvara_manual" }, { source: "world_taekwondo_results" }])).toBe("imported");
  });

  it("participant : une seule source par ligne", () => {
    expect(entryOrigin("ekvara_manual")).toBe("manual");
    expect(entryOrigin("martial_events")).toBe("imported");
  });
});

describe("detectDuplicateEntries", () => {
  const existing = (id: string, participant_name: string, source_category_raw_label: string): ExistingEntry => ({
    id,
    participant_name,
    source_category_raw_label,
    club: null,
    country: null,
    source: "martial_events",
  });

  it("même nom (ordre inversé) et même catégorie (casse/accents ignorés) -> probable", () => {
    expect(detectDuplicateEntries({ participantName: "Emma Dubois", category: "Séniors F -57kg" }, [existing("e1", "DUBOIS Emma", "seniors f -57kg")])).toEqual([
      expect.objectContaining({ id: "e1", level: "probable", reasons: expect.arrayContaining(["même catégorie"]) }),
    ]);
  });

  it("même nom, autre catégorie -> possible ; autre nom -> ignoré", () => {
    const candidates = detectDuplicateEntries({ participantName: "Emma Dubois", category: "Seniors F -57kg" }, [
      existing("e1", "DUBOIS Emma", "Seniors F -62kg"),
      existing("e2", "Lea Martin", "Seniors F -57kg"),
    ]);
    expect(candidates).toEqual([expect.objectContaining({ id: "e1", level: "possible" })]);
  });
});
