// Machine d'état PURE (aucun I/O) du moteur de backfill #12E. Seule source de
// vérité des transitions autorisées — le repository et le service s'appuient
// dessus, jamais l'inverse. Testée isolément sans DB.
//
// Décisions volontaires (voir audit Phase 0, ~/ekvara-checkpoints/12E/audit) :
//   - Pas de statut CANCELLED : aucune commande #12E n'en a besoin (un run
//     BLOCKED/FAILED reste simplement en l'état jusqu'à retry/resume).
//   - Politique fail-closed : un event BLOCKED ou FAILED arrête la
//     progression automatique du run (le run prend le même statut). Reprise
//     uniquement via une action opérateur explicite (retry puis resume).
//   - BLOCKED et FAILED sont tous deux "retry-able" côté event : FAILED
//     couvre l'erreur technique potentiellement transitoire, BLOCKED
//     nécessite une analyse préalable mais le ticket ne restreint pas la
//     commande "retry event" au seul cas FAILED — c'est à l'opérateur de
//     juger avant de relancer.

export type WtBackfillRunStatus = "PENDING" | "RUNNING" | "COMPLETED" | "BLOCKED" | "FAILED";
export type WtBackfillEventStatus = "PENDING" | "RUNNING" | "COMPLETED" | "BLOCKED" | "FAILED";
export type WtrMappingVerdictForBackfill = "SAFE" | "AMBIGUOUS" | "UNMATCHED";

const RUN_TRANSITIONS: Record<WtBackfillRunStatus, WtBackfillRunStatus[]> = {
  PENDING: ["RUNNING"],
  RUNNING: ["COMPLETED", "BLOCKED", "FAILED"],
  COMPLETED: [],
  BLOCKED: ["RUNNING"],
  FAILED: ["RUNNING"],
};

const EVENT_TRANSITIONS: Record<WtBackfillEventStatus, WtBackfillEventStatus[]> = {
  // Un event PENDING peut redevenir PENDING (retry immédiat non nécessaire,
  // mais on n'interdit pas explicitement PENDING->PENDING ; non utilisé en
  // pratique par le service).
  PENDING: ["RUNNING"],
  // RUNNING->PENDING couvre deux cas volontairement identiques : reprise
  // "stale" détectée au démarrage (crash) et interruption propre SIGINT/SIGTERM.
  RUNNING: ["COMPLETED", "BLOCKED", "FAILED", "PENDING"],
  COMPLETED: [],
  BLOCKED: ["PENDING"],
  FAILED: ["PENDING"],
};

export function isValidRunTransition(from: WtBackfillRunStatus, to: WtBackfillRunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function assertValidRunTransition(from: WtBackfillRunStatus, to: WtBackfillRunStatus): void {
  if (!isValidRunTransition(from, to)) {
    throw new Error(`Transition de run invalide: ${from} -> ${to}`);
  }
}

export function isValidEventTransition(from: WtBackfillEventStatus, to: WtBackfillEventStatus): boolean {
  return EVENT_TRANSITIONS[from].includes(to);
}

export function assertValidEventTransition(from: WtBackfillEventStatus, to: WtBackfillEventStatus): void {
  if (!isValidEventTransition(from, to)) {
    throw new Error(`Transition d'event invalide: ${from} -> ${to}`);
  }
}

// Statut initial d'un event à la discovery : un mapping non SAFE est
// immédiatement BLOCKED — il ne sera JAMAIS traité tant qu'un opérateur n'a
// pas explicitement décidé d'un retry (voir wt-backfill-state "Canonical
// competition safety" dans le ticket : jamais de fusion/élargissement auto).
export function initialEventStatus(mappingVerdict: WtrMappingVerdictForBackfill): WtBackfillEventStatus {
  return mappingVerdict === "SAFE" ? "PENDING" : "BLOCKED";
}

// Un event ne peut être (re)traité que s'il est PENDING. COMPLETED n'est
// jamais retraité implicitement (invariant central du ticket).
export function isEventProcessable(status: WtBackfillEventStatus): boolean {
  return status === "PENDING";
}

// Le run passe à l'état correspondant dès qu'un event se termine autrement
// que COMPLETED (fail-closed : on arrête la progression du run, pas
// seulement celle de l'event). Retourne null si le run doit continuer.
export function runStatusAfterEventOutcome(eventOutcome: WtBackfillEventStatus): WtBackfillRunStatus | null {
  if (eventOutcome === "BLOCKED") return "BLOCKED";
  if (eventOutcome === "FAILED") return "FAILED";
  return null;
}
