import type { AthletePreparationRow } from "./participations.repository";
import { toCompetitionView } from "./participation-views";

// Vue Athlete-safe d'une coach_competition_preparation. Volontairement AUCUN
// id de préparation, coach_id, objectif ni note_coach : une préparation reste
// une ressource privée du coach, l'athlète n'en voit que ce qui l'aide à
// comprendre sa situation (statut + catégories prévues). Ce n'est JAMAIS une
// participation : l'inscription officielle reste exclusivement portée par
// `participation`.
export interface AthleteCoachPreparationView {
  competitionId: string;
  source: "coach_preparation";
  status: string;
  categorieAgePrevue: string | null;
  categoriePoidsPrevue: string | null;
  competition: ReturnType<typeof toCompetitionView>;
}

// Sous-ensemble embarqué dans GET .../competitions/next quand une
// participation officielle existe déjà pour la même compétition.
export interface AthleteCoachPreparationSummary {
  status: string;
  categorieAgePrevue: string | null;
  categoriePoidsPrevue: string | null;
}

// Statut interne de préparation coach (voir PREPARATION_STATUSES côté coach) :
// "forfait" = l'athlète ne participera pas. Même famille que
// INACTIVE_PARTICIPATION_STATUSES : jamais présenté comme échéance active.
export const FORFAIT_PREPARATION_STATUS = "forfait";

// Progression de la préparation, utilisée UNIQUEMENT pour départager
// déterministiquement deux coachs qui préparent le même athlète pour la même
// compétition avec des statuts différents : le plus avancé l'emporte. Un
// statut inconnu (varchar libre en base) vaut 0 — jamais promu par hasard.
const PREPARATION_STATUS_RANK: Record<string, number> = { envisage: 1, selectionne: 2, pret: 3 };

export function isActivePreparation(view: Pick<AthleteCoachPreparationView, "status">): boolean {
  return view.status !== FORFAIT_PREPARATION_STATUS;
}

function rankOf(status: string): number {
  return PREPARATION_STATUS_RANK[status] ?? 0;
}

// Une catégorie n'est exposée que si toutes les préparations (non forfait)
// qui en fournissent une s'accordent. Deux coachs en désaccord (-68kg vs
// -74kg) -> null : jamais un choix arbitraire présenté comme fait établi.
function agreedCategory(values: (string | null)[]): string | null {
  const distinct = new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v));
  return distinct.size === 1 ? [...distinct][0] : null;
}

// UNE seule entrée par compétition quel que soit le nombre de coachs. Les
// préparations "forfait" ne comptent que si TOUTES les préparations de la
// compétition sont forfait (un coach encore actif garde la compétition
// active). Résultat trié par date de début croissante (puis nom, puis id,
// pour un ordre stable).
export function resolveCoachPreparations(rows: AthletePreparationRow[]): AthleteCoachPreparationView[] {
  const byCompetition = new Map<string, AthletePreparationRow[]>();
  for (const row of rows) {
    const list = byCompetition.get(row.competition_id) ?? [];
    list.push(row);
    byCompetition.set(row.competition_id, list);
  }

  const views: AthleteCoachPreparationView[] = [];
  for (const group of byCompetition.values()) {
    const active = group.filter((row) => row.statut !== FORFAIT_PREPARATION_STATUS);
    const pool = active.length > 0 ? active : group;

    const status = [...pool].map((row) => row.statut).sort((a, b) => rankOf(b) - rankOf(a) || a.localeCompare(b))[0];

    views.push({
      competitionId: group[0].competition_id,
      source: "coach_preparation",
      status,
      categorieAgePrevue: agreedCategory(pool.map((row) => row.categorie_age_prevue)),
      categoriePoidsPrevue: agreedCategory(pool.map((row) => row.categorie_poids_prevue)),
      competition: toCompetitionView(group[0].competition),
    });
  }

  return views.sort(
    (a, b) =>
      a.competition.dateDebut.getTime() - b.competition.dateDebut.getTime() ||
      a.competition.nom.localeCompare(b.competition.nom) ||
      a.competitionId.localeCompare(b.competitionId),
  );
}

export function toPreparationSummary(view: AthleteCoachPreparationView): AthleteCoachPreparationSummary {
  return {
    status: view.status,
    categorieAgePrevue: view.categorieAgePrevue,
    categoriePoidsPrevue: view.categoriePoidsPrevue,
  };
}
