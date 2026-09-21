import { FORFAIT_PREPARATION_STATUS } from "../coach/coach-competition-preparation-status";

// SEULE définition de "prochaine compétition" d'un athlète, partagée par la
// vue Athlete (ParticipationsService) et la vue Coach (CoachDashboardService :
// fiche athlète, dashboard, groupes). Fonction pure, sans accès aux données ni
// à l'autorisation : chaque appelant fournit ses candidats (l'Athlete des
// préparations athlete-safe tous coachs confondus, le Coach uniquement SES
// préparations) et garde son propre DTO de sortie.
//
// Règles :
//  - candidats = participations ACTIVES à venir + préparations coach ACTIVES
//    (statut != forfait) à venir ;
//  - la plus proche par date de début l'emporte ;
//  - une compétition portée par une participation (de n'importe quel statut,
//    même annulée/retirée) n'est jamais présentée comme "prévue par le coach" :
//    la participation reste la source de l'état d'inscription ;
//  - participation + préparation sur la même compétition = UNE seule entrée
//    (la participation, enrichie de la préparation) ;
//  - à date égale entre deux compétitions différentes, la participation prime.

export interface NextCompetitionCandidate<T> {
  competitionId: string;
  startDate: Date;
  value: T;
}

export interface PreparationCandidate<T> extends NextCompetitionCandidate<T> {
  status: string;
}

export type NextCompetitionChoice<P, R> =
  | { source: "participation"; participation: P; preparation: R | null }
  | { source: "coach_preparation"; preparation: R };

export function isActivePreparationStatus(status: string): boolean {
  return status !== FORFAIT_PREPARATION_STATUS;
}

// competition.date_debut/date_fin sont des DATE (sans heure) : on compare à
// minuit UTC du jour courant pour qu'une compétition ayant lieu aujourd'hui
// reste éligible au lieu de disparaître à cause de l'heure courante.
export function todayUtcMidnight(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function earliest<T extends { startDate: Date }>(candidates: T[]): T | undefined {
  let best: T | undefined;
  for (const candidate of candidates) {
    if (!best || candidate.startDate.getTime() < best.startDate.getTime()) best = candidate;
  }
  return best;
}

export function selectNextCompetition<P, R>(input: {
  // Participations actives (statut hors annule/retire) et à venir.
  activeParticipations: NextCompetitionCandidate<P>[];
  // Préparations à venir (une par compétition), tous statuts : le forfait est filtré ici.
  preparations: PreparationCandidate<R>[];
  // Compétitions où une participation existe, QUEL QUE SOIT son statut.
  competitionIdsWithParticipation: ReadonlySet<string>;
}): NextCompetitionChoice<P, R> | null {
  const activePreparations = input.preparations.filter((p) => isActivePreparationStatus(p.status));

  const blocked = new Set(input.competitionIdsWithParticipation);
  for (const participation of input.activeParticipations) blocked.add(participation.competitionId);

  const nextParticipation = earliest(input.activeParticipations);
  const preparationOnly = earliest(activePreparations.filter((p) => !blocked.has(p.competitionId)));

  if (nextParticipation && (!preparationOnly || nextParticipation.startDate.getTime() <= preparationOnly.startDate.getTime())) {
    const enrichment = activePreparations.find((p) => p.competitionId === nextParticipation.competitionId);
    return {
      source: "participation",
      participation: nextParticipation.value,
      preparation: enrichment ? enrichment.value : null,
    };
  }

  return preparationOnly ? { source: "coach_preparation", preparation: preparationOnly.value } : null;
}
