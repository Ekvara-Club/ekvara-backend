// Réconciliation CONSERVATRICE d'une représentation de match WT Results avec
// les combats déjà connus (voir Ticket #12B). WT Results publie parfois le même
// combat réel sous plusieurs identifiants de match (Muju : 4 pages identiques).
//
// Clé de rapprochement (jamais une contrainte UNIQUE en base : un cas
// conflictuel doit pouvoir rester stocké) :
//   (competition_id, category_label, contest_number, paire NON ORDONNÉE d'athlètes)
// La recherche des candidats par cette clé est faite par le repository ; ce
// module décide uniquement, de façon pure, quoi faire de ces candidats.
//
//   SAME_LOGICAL_FIGHT : tous les attributs critiques sont identiques ->
//                        rattacher l'identifiant source au competition_match existant ;
//   CONFLICT           : la clé correspond mais un attribut critique diverge ->
//                        NE PAS fusionner, conserver les données, signaler ;
//   AMBIGUOUS          : plusieurs combats existants sont cohérents avec la
//                        représentation -> aucun choix arbitraire, conserver, signaler ;
//   CREATE             : aucun candidat (ou clé indéterminée) -> nouveau combat.

export interface MatchFacts {
  athleteAId: string;
  athleteBId: string;
  scoreA: number | null;
  scoreB: number | null;
  winnerAthleteId: string | null;
  resultMethod: string | null;
  bracketStage: string | null;
}

export interface ReconciliationCandidate {
  matchId: string;
  facts: MatchFacts;
}

export type ReconciliationDecision =
  | { kind: "CREATE" }
  | { kind: "SAME_LOGICAL_FIGHT"; matchId: string }
  | { kind: "CONFLICT"; conflictingMatchIds: string[]; differences: string[] }
  | { kind: "AMBIGUOUS"; matchIds: string[] };

// Numéro de combat 0 valide : comparaison explicite, jamais un test truthy.
export function hasLogicalKey(input: { categoryLabel: string | null; contestNumber: number | null }): boolean {
  return input.categoryLabel !== null && input.categoryLabel !== "" && input.contestNumber !== null;
}

// Attributs critiques divergents, nommés. L'orientation (athlète A/B) en fait
// partie : le combat est le même mais l'ordre de la page source diffère, ce qui
// change la lecture de score_a/score_b — jamais fusionné silencieusement.
export function diffMatchFacts(a: MatchFacts, b: MatchFacts): string[] {
  const differences: string[] = [];
  if (a.athleteAId !== b.athleteAId || a.athleteBId !== b.athleteBId) differences.push("orientation");
  if (a.scoreA !== b.scoreA) differences.push("scoreA");
  if (a.scoreB !== b.scoreB) differences.push("scoreB");
  if (a.winnerAthleteId !== b.winnerAthleteId) differences.push("winner");
  if (a.resultMethod !== b.resultMethod) differences.push("method");
  if (a.bracketStage !== b.bracketStage) differences.push("bracketStage");
  return differences;
}

export function reconcileMatch(incoming: MatchFacts, candidates: ReconciliationCandidate[]): ReconciliationDecision {
  if (candidates.length === 0) return { kind: "CREATE" };

  const evaluated = candidates.map((c) => ({ ...c, differences: diffMatchFacts(incoming, c.facts) }));
  const consistent = evaluated.filter((c) => c.differences.length === 0);

  if (consistent.length === 1) return { kind: "SAME_LOGICAL_FIGHT", matchId: consistent[0].matchId };
  if (consistent.length > 1) return { kind: "AMBIGUOUS", matchIds: consistent.map((c) => c.matchId) };

  return {
    kind: "CONFLICT",
    conflictingMatchIds: evaluated.map((c) => c.matchId),
    differences: [...new Set(evaluated.flatMap((c) => c.differences))],
  };
}
