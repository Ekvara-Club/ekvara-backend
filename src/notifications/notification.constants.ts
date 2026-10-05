// Listes courtes et contrôlées, jamais un enum Prisma (même politique que
// tous les statuts varchar de ce projet : participation.statut,
// coach_competition_preparation.statut, training_attendance.status...).
//
// Types V1 (ticket "Notifications in-app Coach + Athlete V1") : uniquement
// les 6 types réellement câblés à une mutation coach existante.
// COMPETITION_PREPARATION_UPDATED et ATTENDANCE_ATTENTION ont été évalués
// pendant l'audit puis explicitement écartés (voir rapport final) :
// coach_competition_preparation reste strictement privée au coach (aucune
// exposition athlète nulle part dans le code), et le signal d'attendance
// reste calculé dynamiquement par le dashboard groupe (risque de doublons/
// staleness documenté par le ticket).
export const NOTIFICATION_TYPES = [
  "TRAINING_ASSIGNED",
  "TRAINING_UPDATED",
  "TRAINING_CANCELLED",
  "EXERCISE_ASSIGNED",
  "GOAL_UPDATED",
  "WEIGHT_TARGET_UPDATED",
  // Premier type produit pour le contexte COACH : un athlète change son
  // état de forme (voir AthletesService.updateCondition).
  "ATHLETE_CONDITION_UPDATED",
  // Lien compte EKVARA <-> profil World Taekwondo (voir WtLinksService).
  "WT_PROFILE_LINK_REQUESTED",
  "WT_PROFILE_LINK_CONFIRMED",
  "WT_PROFILE_LINK_REJECTED",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// Constantes individuelles nommées (même précédent que
// CANCELLED_TRAINING_STATUS dans trainings.repository.ts) : évite toute
// indexation positionnelle (NOTIFICATION_TYPES[1]) dans le code appelant.
export const TRAINING_ASSIGNED: NotificationType = "TRAINING_ASSIGNED";
export const TRAINING_UPDATED: NotificationType = "TRAINING_UPDATED";
export const TRAINING_CANCELLED: NotificationType = "TRAINING_CANCELLED";
export const EXERCISE_ASSIGNED: NotificationType = "EXERCISE_ASSIGNED";
export const GOAL_UPDATED: NotificationType = "GOAL_UPDATED";
export const WEIGHT_TARGET_UPDATED: NotificationType = "WEIGHT_TARGET_UPDATED";
export const ATHLETE_CONDITION_UPDATED: NotificationType = "ATHLETE_CONDITION_UPDATED";
export const WT_PROFILE_LINK_REQUESTED: NotificationType = "WT_PROFILE_LINK_REQUESTED";
export const WT_PROFILE_LINK_CONFIRMED: NotificationType = "WT_PROFILE_LINK_CONFIRMED";
export const WT_PROFILE_LINK_REJECTED: NotificationType = "WT_PROFILE_LINK_REJECTED";

// Un app_user peut posséder à la fois athlete et coach_profile (compte
// hybride, voir JwtPayload) : `context` distingue l'interface pour laquelle
// une notification a du sens, pour qu'un même compte ne voie jamais dans
// CoachFrontend une notification rédigée pour l'athlète (et inversement).
// Seul ATHLETE est produit en V1 (voir rapport final "notifications coach") ;
// COACH existe dès maintenant dans le modèle pour ne jamais avoir à migrer
// ce champ plus tard.
export const NOTIFICATION_CONTEXTS = ["ATHLETE", "COACH"] as const;

export type NotificationContext = (typeof NOTIFICATION_CONTEXTS)[number];

// Sert uniquement au deep-link frontend (voir NotificationsService) — ne
// remplace jamais l'autorisation backend normale de la ressource.
export const NOTIFICATION_RESOURCE_TYPES = [
  "TRAINING",
  "EXERCISE",
  "GOAL",
  "WEIGHT_TARGET",
  "COMPETITION",
  "ATHLETE",
  // Le profil WT de l'athlète (deep-link athlète : son Passeport).
  "WT_PROFILE",
] as const;

export type NotificationResourceType = (typeof NOTIFICATION_RESOURCE_TYPES)[number];

export const TRAINING_RESOURCE: NotificationResourceType = "TRAINING";
export const EXERCISE_RESOURCE: NotificationResourceType = "EXERCISE";
export const GOAL_RESOURCE: NotificationResourceType = "GOAL";
export const WEIGHT_TARGET_RESOURCE: NotificationResourceType = "WEIGHT_TARGET";
export const ATHLETE_RESOURCE: NotificationResourceType = "ATHLETE";
export const WT_PROFILE_RESOURCE: NotificationResourceType = "WT_PROFILE";
