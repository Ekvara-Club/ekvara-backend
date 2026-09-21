import { hasLogicalKey, reconcileMatch, diffMatchFacts, type MatchFacts } from "./wtr-match-reconciliation";

const A = "athlete-a";
const B = "athlete-b";

const facts = (overrides: Partial<MatchFacts> = {}): MatchFacts => ({
  athleteAId: A,
  athleteBId: B,
  scoreA: 0,
  scoreB: 2,
  winnerAthleteId: B,
  resultMethod: "PTF",
  bracketStage: "R32",
  ...overrides,
});

const candidate = (matchId: string, overrides: Partial<MatchFacts> = {}) => ({ matchId, facts: facts(overrides) });

describe("hasLogicalKey", () => {
  it("clé exploitable seulement avec catégorie ET n° de combat", () => {
    expect(hasLogicalKey({ categoryLabel: "Men -68kg", contestNumber: 101 })).toBe(true);
    expect(hasLogicalKey({ categoryLabel: "Men -68kg", contestNumber: 0 })).toBe(true); // 0 est un numéro valide
    expect(hasLogicalKey({ categoryLabel: null, contestNumber: 101 })).toBe(false);
    expect(hasLogicalKey({ categoryLabel: "Men -68kg", contestNumber: null })).toBe(false);
    expect(hasLogicalKey({ categoryLabel: "", contestNumber: 101 })).toBe(false);
  });
});

describe("diffMatchFacts", () => {
  it("identiques -> aucune différence", () => {
    expect(diffMatchFacts(facts(), facts())).toEqual([]);
  });

  it("nomme chaque attribut critique divergent", () => {
    expect(diffMatchFacts(facts(), facts({ scoreA: 1 }))).toEqual(["scoreA"]);
    expect(diffMatchFacts(facts(), facts({ scoreB: 1 }))).toEqual(["scoreB"]);
    expect(diffMatchFacts(facts(), facts({ winnerAthleteId: A }))).toEqual(["winner"]);
    expect(diffMatchFacts(facts(), facts({ resultMethod: "PTG" }))).toEqual(["method"]);
    expect(diffMatchFacts(facts(), facts({ bracketStage: "R16" }))).toEqual(["bracketStage"]);
  });

  it("orientation A/B inversée = divergence (même paire, mais l'ordre de la page source diffère)", () => {
    const swapped = facts({ athleteAId: B, athleteBId: A, scoreA: 2, scoreB: 0 });

    expect(diffMatchFacts(facts(), swapped)).toContain("orientation");
  });

  it("null n'est égal qu'à null (jamais à 0 ni à une valeur)", () => {
    expect(diffMatchFacts(facts({ scoreA: null }), facts({ scoreA: null }))).toEqual([]);
    expect(diffMatchFacts(facts({ scoreA: null }), facts({ scoreA: 0 }))).toEqual(["scoreA"]);
    expect(diffMatchFacts(facts({ winnerAthleteId: null }), facts({ winnerAthleteId: B }))).toEqual(["winner"]);
  });
});

describe("reconcileMatch", () => {
  it("aucun candidat -> CREATE", () => {
    expect(reconcileMatch(facts(), [])).toEqual({ kind: "CREATE" });
  });

  it("un candidat strictement cohérent -> SAME_LOGICAL_FIGHT (rattacher au même competition_match)", () => {
    expect(reconcileMatch(facts(), [candidate("m1")])).toEqual({ kind: "SAME_LOGICAL_FIGHT", matchId: "m1" });
  });

  it("clé identique mais score divergent -> CONFLICT, jamais de fusion, différences nommées", () => {
    const decision = reconcileMatch(facts(), [candidate("m1", { scoreA: 1, scoreB: 2 })]);

    expect(decision).toEqual({ kind: "CONFLICT", conflictingMatchIds: ["m1"], differences: ["scoreA"] });
  });

  it("vainqueur, méthode ou tour divergent -> CONFLICT", () => {
    expect(reconcileMatch(facts(), [candidate("m1", { winnerAthleteId: A })]).kind).toBe("CONFLICT");
    expect(reconcileMatch(facts(), [candidate("m1", { resultMethod: "WDR" })]).kind).toBe("CONFLICT");
    expect(reconcileMatch(facts(), [candidate("m1", { bracketStage: "QF" })]).kind).toBe("CONFLICT");
  });

  it("orientation inversée -> CONFLICT (jamais fusionnée silencieusement)", () => {
    const decision = reconcileMatch(facts(), [candidate("m1", { athleteAId: B, athleteBId: A, scoreA: 2, scoreB: 0 })]);

    expect(decision.kind).toBe("CONFLICT");
  });

  it("un conflit déjà conservé + une copie cohérente avec l'ORIGINAL -> rattachée à l'original", () => {
    const decision = reconcileMatch(facts(), [candidate("original"), candidate("conflit", { scoreA: 2, scoreB: 0, winnerAthleteId: A })]);

    expect(decision).toEqual({ kind: "SAME_LOGICAL_FIGHT", matchId: "original" });
  });

  it("copie cohérente avec la ligne CONFLICTUELLE déjà conservée -> rattachée à celle-là", () => {
    const incoming = facts({ scoreA: 2, scoreB: 0, winnerAthleteId: A });

    const decision = reconcileMatch(incoming, [candidate("original"), candidate("conflit", { scoreA: 2, scoreB: 0, winnerAthleteId: A })]);

    expect(decision).toEqual({ kind: "SAME_LOGICAL_FIGHT", matchId: "conflit" });
  });

  it("plusieurs candidats cohérents (doublons non fusionnés préexistants) -> AMBIGUOUS, pas de choix arbitraire", () => {
    const decision = reconcileMatch(facts(), [candidate("m1"), candidate("m2")]);

    expect(decision).toEqual({ kind: "AMBIGUOUS", matchIds: ["m1", "m2"] });
  });

  it("aucun candidat cohérent parmi plusieurs -> CONFLICT avec tous les ids", () => {
    const decision = reconcileMatch(facts(), [candidate("m1", { scoreA: 1 }), candidate("m2", { resultMethod: "WDR" })]);

    expect(decision).toMatchObject({ kind: "CONFLICT", conflictingMatchIds: ["m1", "m2"] });
  });
});
