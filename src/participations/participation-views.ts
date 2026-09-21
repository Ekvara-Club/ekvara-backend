import type { ParticipationWithCompetition } from "./participations.repository";

export function toCompetitionView(competition: ParticipationWithCompetition["competition"]) {
  return {
    id: competition.id,
    nom: competition.nom,
    dateDebut: competition.date_debut,
    dateFin: competition.date_fin,
    lieu: competition.lieu,
    ville: competition.ville,
    pays: competition.pays,
    niveau: competition.niveau,
    source: competition.sources[0]?.source ?? null,
  };
}
