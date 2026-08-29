// Liste courte et contrôlée (ticket §5 : "éviter 12 statuts inutiles"),
// directement reprise de l'exemple donné par le ticket — pas un vocabulaire
// inventé indépendamment. Aucun statut "confirmé"/"inscrit" ici : cette
// notion appartient exclusivement à `participation.statut` (inscription
// officielle), jamais mélangée avec le statut de préparation interne du
// coach (voir CoachCompetitionPreparationsService).
export const PREPARATION_STATUSES = ["envisage", "selectionne", "pret", "forfait"] as const;

export type PreparationStatus = (typeof PREPARATION_STATUSES)[number];

export const DEFAULT_PREPARATION_STATUS: PreparationStatus = "envisage";
