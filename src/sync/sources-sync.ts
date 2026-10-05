import { PrismaService } from "../prisma/prisma.service";
import { NotificationsRepository } from "../notifications/notifications.repository";
import { formatTrainingDate, toNotificationRows } from "../notifications/notifications.util";
import { COMPETITION_RESOURCE, COMPETITION_UPDATED } from "../notifications/notification.constants";
import { INACTIVE_PARTICIPATION_STATUSES } from "../participations/participations.repository";
import { CompetitionFieldChange } from "../competitions/competitions.repository";

// Synchro périodique des sources (tous les 3 jours, voir deploy/) : logique
// pure et notifications, orchestrées par sync-sources.cli.ts.

export interface ChangedCompetition {
  competitionId: string;
  nom: string;
  changes: CompetitionFieldChange[];
}

const FIELD_LABELS: Record<CompetitionFieldChange["field"], string> = {
  date_debut: "date",
  date_fin: "date de fin",
  lieu: "lieu",
  ville: "ville",
  pays: "pays",
};

function formatValue(field: CompetitionFieldChange["field"], value: string | null): string {
  if (value === null) return "—";
  return field === "date_debut" || field === "date_fin" ? formatTrainingDate(new Date(`${value}T12:00:00.000Z`)) : value;
}

// « date 13 mars 2027 → 20 mars 2027, ville Eaubonne → Cergy »
export function describeChanges(changes: CompetitionFieldChange[]): string {
  return changes
    .map((c) => `${FIELD_LABELS[c.field]} ${formatValue(c.field, c.before)} → ${formatValue(c.field, c.after)}`)
    .join(", ");
}

// Prévient les personnes réellement concernées par une compétition modifiée :
// athlètes inscrits (participation active) et coachs qui la préparent pour
// un athlète. Une notification par personne et par compétition.
export async function notifyCompetitionChanges(
  prisma: PrismaService,
  notifications: NotificationsRepository,
  changed: ChangedCompetition[],
): Promise<number> {
  let sent = 0;
  for (const item of changed) {
    const [participations, preparations] = await Promise.all([
      prisma.participation.findMany({
        where: { competition_id: item.competitionId, statut: { notIn: INACTIVE_PARTICIPATION_STATUSES } },
        select: { athlete: { select: { user_id: true } } },
      }),
      prisma.coach_competition_preparation.findMany({
        where: { competition_id: item.competitionId },
        select: { coach_profile: { select: { user_id: true } } },
      }),
    ]);
    const content = {
      type: COMPETITION_UPDATED,
      title: "Compétition modifiée",
      message: `« ${item.nom} » a changé : ${describeChanges(item.changes)}.`,
      resourceType: COMPETITION_RESOURCE,
      resourceId: item.competitionId,
    };
    const athleteRows = toNotificationRows([...new Set(participations.map((p) => p.athlete.user_id))], { ...content, context: "ATHLETE" });
    const coachRows = toNotificationRows([...new Set(preparations.map((p) => p.coach_profile.user_id))], { ...content, context: "COACH" });
    const { count } = await notifications.createMany(prisma, [...athleteRows, ...coachRows]);
    sent += count;
  }
  return sent;
}

export interface WtEventRef {
  slug: string;
  dateEnd: Date;
}

// Résultats WT à importer automatiquement : compétitions TERMINÉES (veille
// au plus tard) depuis `windowDays` jours, jamais déjà importées, et jamais
// présentes dans un run de backfill, quel que soit son statut — un événement
// en pause ou en échec (ex. backfill #23) ne se reprend qu'à la main.
export function selectRecentWtSlugs(
  items: WtEventRef[],
  alreadyImported: Set<string>,
  alreadyQueued: Set<string>,
  now: Date,
  windowDays = 30,
): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = today - windowDays * 86_400_000;
  return items
    .filter((i) => i.dateEnd.getTime() >= from && i.dateEnd.getTime() < today)
    .filter((i) => !alreadyImported.has(i.slug) && !alreadyQueued.has(i.slug))
    .map((i) => i.slug)
    .sort();
}
