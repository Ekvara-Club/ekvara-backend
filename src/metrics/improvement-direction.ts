// `metric_type.improvement_direction` est un VARCHAR(10) nullable (pas d'enum
// Prisma pour cette V1, cf. rapport d'analyse). Cette constante est la seule
// source de vérité des valeurs acceptées côté application, pour qu'aucune
// chaîne arbitraire ne soit interprétée comme une direction valide.
export const IMPROVEMENT_DIRECTIONS = ["higher", "lower"] as const;

export type ImprovementDirection = (typeof IMPROVEMENT_DIRECTIONS)[number];

// `null` (ou toute valeur hors de la liste) signifie que la direction n'est
// pas encore connue : la métrique ne doit pas être interprétée automatiquement.
export function isImprovementDirection(value: unknown): value is ImprovementDirection {
  return (
    typeof value === "string" &&
    (IMPROVEMENT_DIRECTIONS as readonly string[]).includes(value)
  );
}
