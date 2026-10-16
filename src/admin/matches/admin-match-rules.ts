import { diffMatchFacts, MatchFacts, reconcileMatch } from "../../international/wt-results/wtr-match-reconciliation";
import { MANUAL_SOURCE } from "../competitions/admin-competition-origin";

// Combats (competition_match) saisis dans EkvaraAdmin.

// Tours du tableau, convention de l'import WT (STAGE_ORDER, international.service).
export const STAGES = ["R128", "R64", "R32", "R16", "QF", "SF", "BMC", "F"] as const;

export type MatchOrigin = "manual" | "imported";

// "manual" uniquement si TOUTES les représentations source sont manuelles :
// dès qu'un import WT a rattaché sa représentation (SAME_LOGICAL_FIGHT), le
// combat est importé, donc en lecture seule (décision D6).
export function matchOrigin(sources: { source: string }[]): MatchOrigin {
  return sources.length > 0 && sources.every((s) => s.source === MANUAL_SOURCE) ? "manual" : "imported";
}

export interface ExistingMatchFacts extends MatchFacts {
  id: string;
}

export type MatchCandidateLevel = "identical" | "conflict" | "possible";

export interface MatchCandidateRef {
  id: string;
  level: MatchCandidateLevel;
  differences: string[];
}

// Analyse des doublons AVANT écriture, avec la règle de rapprochement de
// l'import WT (reconcileMatch / diffMatchFacts, inchangées) :
// - même clé logique (compétition, catégorie, n° de combat, paire non
//   ordonnée) et mêmes faits -> "identical" : le combat existe déjà,
//   création REFUSÉE (jamais confirmable) ;
// - même clé, faits différents -> "conflict" : les deux versions sont
//   présentées, création possible seulement après confirmation explicite
//   (comme l'import WT, qui conserve aussi les deux en cas de CONFLICT) ;
// - même paire d'athlètes ailleurs dans la compétition -> "possible".
// Aucun cas ne fusionne quoi que ce soit.
export function analyseMatchDuplicates(
  input: MatchFacts,
  sameKey: ExistingMatchFacts[],
  samePair: ExistingMatchFacts[],
): MatchCandidateRef[] {
  const refs: MatchCandidateRef[] = [];
  const decision = reconcileMatch(
    input,
    sameKey.map((m) => ({ matchId: m.id, facts: m })),
  );
  if (decision.kind === "SAME_LOGICAL_FIGHT") refs.push({ id: decision.matchId, level: "identical", differences: [] });
  if (decision.kind === "AMBIGUOUS") refs.push(...decision.matchIds.map((id) => ({ id, level: "identical" as const, differences: [] })));
  if (decision.kind === "CONFLICT") {
    for (const match of sameKey) refs.push({ id: match.id, level: "conflict", differences: diffMatchFacts(input, match) });
  }
  const seen = new Set(refs.map((r) => r.id));
  for (const match of samePair) {
    if (!seen.has(match.id)) refs.push({ id: match.id, level: "possible", differences: diffMatchFacts(input, match) });
  }
  return refs;
}
