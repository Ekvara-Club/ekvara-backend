// Calcul présentationnel isolé (voir ticket §11) : aucune fonction daysUntil
// n'existe ailleurs dans le backend. Compare à minuit UTC, même convention
// que ParticipationsService.assertCompetitionIsOver — une compétition/un
// entraînement/un objectif "aujourd'hui" donne toujours daysUntil = 0, jamais
// négatif à cause de l'heure courante.
export function daysUntil(target: Date, from: Date): number {
  const targetMidnight = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate());
  const fromMidnight = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  return Math.round((targetMidnight - fromMidnight) / (24 * 60 * 60 * 1000));
}
