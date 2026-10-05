// Note /100 d'une capacité pour l'étoile de compétences, à partir du barème
// de son metric_type (score_zero -> 0, score_hundred -> 100). Fonctionne
// dans les deux sens : pour une capacité "lower", score_zero > score_hundred.
// Bornée à [0, 100], arrondie à l'entier. null si la valeur ou le barème
// manque (ou barème dégénéré) : jamais une note inventée.
export function computeSkillScore(
  value: number | null,
  scoreZero: number | null,
  scoreHundred: number | null,
): number | null {
  if (value === null || scoreZero === null || scoreHundred === null || scoreZero === scoreHundred) {
    return null;
  }
  const raw = ((value - scoreZero) / (scoreHundred - scoreZero)) * 100;
  return Math.round(Math.min(100, Math.max(0, raw)));
}
