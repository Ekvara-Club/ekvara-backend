// Capacités suivies par EKVARA (metric_type). Jusqu'ici créées à la main en
// base de développement : sans ce seed, une base de production neuve n'aurait
// AUCUNE capacité (Progression, étoile et mesures coach vides).
// improvement_direction : "higher" = plus haut est meilleur, "lower" = plus
// bas est meilleur (temps de réaction). score_zero/score_hundred = barème
// par défaut de l'étoile (les clubs règlent le leur, voir club_metric_scale).
export const METRIC_TYPES_SEED_DATA = [
  { code: "endurance", nom: "Endurance", unite: "points", improvement_direction: "higher", score_zero: 0, score_hundred: 100 },
  { code: "force", nom: "Force", unite: "kg", improvement_direction: "higher", score_zero: 40, score_hundred: 140 },
  { code: "souplesse", nom: "Souplesse", unite: "cm", improvement_direction: "higher", score_zero: 0, score_hundred: 50 },
  { code: "technique", nom: "Technique", unite: "points", improvement_direction: "higher", score_zero: 0, score_hundred: 100 },
  { code: "temps_reaction", nom: "Temps de réaction", unite: "ms", improvement_direction: "lower", score_zero: 600, score_hundred: 250 },
  { code: "vitesse", nom: "Vitesse", unite: "points", improvement_direction: "higher", score_zero: 0, score_hundred: 100 },
] as const;
