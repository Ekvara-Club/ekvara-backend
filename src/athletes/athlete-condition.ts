// État de forme déclaré par l'athlète (voir schema.prisma, athlete.etat_forme).
// Liste courte contrôlée en application, jamais un enum Prisma (même
// politique que tous les statuts varchar du projet).
export const ATHLETE_CONDITIONS = ["actif", "malade", "blesse", "absent"] as const;
export type AthleteCondition = (typeof ATHLETE_CONDITIONS)[number];

export const ACTIVE_CONDITION: AthleteCondition = "actif";

// Libellés FR utilisés dans le texte SNAPSHOT des notifications coach.
export const ATHLETE_CONDITION_LABELS: Record<AthleteCondition, string> = {
  actif: "Actif",
  malade: "Malade",
  blesse: "Blessé",
  absent: "Absent",
};

// Date du jour à Paris (YYYY-MM-DD) : une date de retour prévue ne peut pas
// être déjà passée. Même fuseau unique que le reste du projet.
const PARIS_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Paris",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function todayInParis(now: Date = new Date()): string {
  return PARIS_DATE.format(now);
}
