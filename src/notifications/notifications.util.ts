import { NotificationContext, NotificationResourceType, NotificationType } from "./notification.constants";

// Ligne prête à insérer (Prisma notification.createMany), en snake_case pour
// correspondre exactement aux colonnes de schema.prisma — aucune
// transformation supplémentaire côté repository.
export interface NotificationInsertRow {
  recipient_user_id: string;
  actor_user_id: string | null;
  context: string;
  type: string;
  title: string;
  message: string | null;
  resource_type: string | null;
  resource_id: string | null;
}

export interface NotificationContent {
  actorUserId?: string | null;
  context: NotificationContext;
  type: NotificationType;
  title: string;
  message?: string | null;
  resourceType?: NotificationResourceType | null;
  resourceId?: string | null;
}

// Construit les lignes à insérer à partir d'app_user.id déjà résolus et
// dédoublonnés en amont (CoachDestinataireResolver pour les destinataires
// groupe+individuel, ou un athleteId unique pour goals/weight-targets).
// Fonction pure, sans dépendance Prisma/Nest : seule source de vérité du
// mapping contenu -> ligne, réutilisée à la fois par NotificationsService
// (hors transaction, goals/weight-targets) et par les repositories coach qui
// insèrent dans leur propre transaction (trainings, exercises) — voir
// NotificationsRepository.createMany pour l'écriture réelle. Même
// resource_id pour tous les destinataires : pour les cas où le destinataire
// possède SA PROPRE ressource (ex. training_session généré par athlète,
// voir CoachTrainingsRepository), les lignes sont construites manuellement
// à l'appel plutôt qu'avec ce helper.
export function toNotificationRows(recipientUserIds: string[], content: NotificationContent): NotificationInsertRow[] {
  return recipientUserIds.map((recipientUserId) => ({
    recipient_user_id: recipientUserId,
    actor_user_id: content.actorUserId ?? null,
    context: content.context,
    type: content.type,
    title: content.title,
    message: content.message ?? null,
    resource_type: content.resourceType ?? null,
    resource_id: content.resourceId ?? null,
  }));
}

// Formatage FR fixe (Europe/Paris) pour le texte SNAPSHOT stocké en base —
// ne sert jamais à un affichage recalculé à la lecture (voir modèle
// notification). Utilise Intl, déjà disponible nativement (aucune nouvelle
// dépendance) — MVP volontairement mono-fuseau (fédération FR), même
// portée que le reste du projet (voir CLAUDE.md §20 sur les dates).
const TRAINING_DATE_FORMATTER = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris",
  day: "numeric",
  month: "long",
});
const TRAINING_TIME_FORMATTER = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris",
  hour: "2-digit",
  minute: "2-digit",
});

const SERIES_DATE_FORMATTER = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris",
  day: "numeric",
  month: "long",
  year: "numeric",
});

// Bornes d'une série récurrente ("7 octobre 2026") : l'année compte, une
// série peut durer jusqu'à un an.
export function formatTrainingDate(date: Date): string {
  return SERIES_DATE_FORMATTER.format(date);
}

export function formatTrainingDateTime(date: Date): string {
  const day = TRAINING_DATE_FORMATTER.format(date);
  const time = TRAINING_TIME_FORMATTER.format(date).replace(":", "h");
  return `${day} à ${time}`;
}
