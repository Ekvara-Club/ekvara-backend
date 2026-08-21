export interface ExerciseSeedInput {
  titre: string;
  type_exercice: string;
  panel_technique?: string;
  niveau: string;
  description: string;
  video_url: string | null;
  gratuit: boolean;
}

// Aucune URL vidéo fiable n'a été fournie : video_url reste null pour tous les
// exercices seedés, conformément à la consigne de ne jamais inventer de lien.
export const EXERCISES_SEED_DATA: ExerciseSeedInput[] = [
  {
    titre: "Travail du cut en déplacement",
    type_exercice: "technique",
    panel_technique: "cut",
    niveau: "intermediaire",
    description:
      "Enchaîner des cuts jambe avant en gardant les appuis mobiles, pour toucher sans se figer face à un adversaire qui recule.",
    video_url: null,
    gratuit: true,
  },
  {
    titre: "Dollyo jambe arrière sur cible",
    type_exercice: "technique",
    panel_technique: "dollyo",
    niveau: "debutant",
    description:
      "Répéter le dollyo jambe arrière sur pao en insistant sur la rotation de hanche et le retour rapide en garde.",
    video_url: null,
    gratuit: true,
  },
  {
    titre: "Travail de distance et déplacements",
    type_exercice: "technique",
    panel_technique: "deplacement",
    niveau: "intermediaire",
    description:
      "Gérer la distance de combat par petits pas avant/arrière, pour entrer et sortir de la zone de frappe sans se faire surprendre.",
    video_url: null,
    gratuit: true,
  },
  {
    titre: "Fractionné court",
    type_exercice: "physique",
    niveau: "intermediaire",
    description:
      "Séries de 30 secondes d'effort intense suivies de 30 secondes de récupération, pour développer l'endurance spécifique au combat.",
    video_url: null,
    gratuit: true,
  },
  {
    titre: "Explosivité jambes",
    type_exercice: "force",
    niveau: "avance",
    description:
      "Squats sautés et fentes sautées en séries courtes, pour gagner en puissance de départ sur les actions de jambe.",
    video_url: null,
    gratuit: true,
  },
  {
    titre: "Mobilité hanches",
    type_exercice: "mobilite",
    niveau: "debutant",
    description:
      "Rotations et ouvertures de hanche à faible intensité, pour gagner en amplitude avant le travail technique.",
    video_url: null,
    gratuit: true,
  },
  {
    titre: "Temps de réaction sur signal",
    type_exercice: "reaction",
    niveau: "intermediaire",
    description:
      "Départ d'une technique déclenché par un signal visuel ou sonore du partenaire, pour réduire le temps de réponse en combat.",
    video_url: null,
    gratuit: true,
  },
  {
    titre: "Travail de vitesse de frappe",
    type_exercice: "vitesse",
    niveau: "avance",
    description:
      "Séries de frappes rapides et légères sur pao, focus sur la fréquence gestuelle plutôt que sur la puissance.",
    video_url: null,
    gratuit: true,
  },
];
