// Provenance des saisies du portail EkvaraAdmin (convention validée à
// l'audit, phase 1) : jamais utilisée par un importeur existant (fftda,
// world_taekwondo, martial_events, world_taekwondo_results).
export const MANUAL_SOURCE = "ekvara_manual";

export type CompetitionOrigin = "manual" | "imported";

// "manual" UNIQUEMENT si toutes les sources rattachées sont des saisies
// manuelles. Dès qu'une source d'import est rattachée (ex. FFTDA rapprochée
// automatiquement d'une saisie manuelle), ou s'il n'y a aucune source connue,
// la compétition est traitée comme importée : lecture seule hors saison
// (décision D4).
export function competitionOrigin(sources: { source: string }[]): CompetitionOrigin {
  return sources.length > 0 && sources.every((s) => s.source === MANUAL_SOURCE) ? "manual" : "imported";
}

// Champs modifiables par origine. saison : aucun importeur ne l'écrit, aucune
// synchronisation ni règle de rapprochement ne la lit (vérifié en phase 3) —
// la modifier ne change rien au comportement des imports.
export const EDITABLE_FIELDS: Record<CompetitionOrigin, readonly CompetitionField[]> = {
  manual: ["nom", "organisateur", "dateDebut", "dateFin", "lieu", "ville", "pays", "niveau", "saison"],
  imported: ["saison"],
};

export type CompetitionField = "nom" | "organisateur" | "dateDebut" | "dateFin" | "lieu" | "ville" | "pays" | "niveau" | "saison";
