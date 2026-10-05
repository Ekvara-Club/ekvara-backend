// Séances récurrentes coach : calcul pur des occurrences d'une série, sans
// Prisma ni Nest (testable isolément). Le coach raisonne en heure murale
// ("tous les mercredis à 20h") : chaque occurrence est convertie en UTC
// selon Europe/Paris À SA PROPRE DATE, pour que 20h reste 20h de part et
// d'autre d'un changement d'heure — jamais "première occurrence + 7 jours"
// en millisecondes, qui décalerait d'une heure après le passage à l'heure
// d'hiver/été. Même fuseau unique que formatTrainingDateTime
// (notifications.util.ts) : MVP volontairement mono-fuseau.

export const SERIES_TIME_ZONE = "Europe/Paris";

// Durées proposées au coach (ticket : 1 mois, 3 mois, 6 mois ou 1 an).
export const SERIES_DURATION_MONTHS = [1, 3, 6, 12] as const;

export interface SeriesRule {
  startDate: string; // YYYY-MM-DD, premier jour inclus de la fenêtre
  startTime: string; // HH:mm, heure murale Europe/Paris
  endTime?: string; // HH:mm, même jour que le début
  weekdays: number[]; // ISO 8601 : 1 = lundi ... 7 = dimanche
  durationMonths: number;
}

export interface SeriesOccurrence {
  startAt: Date;
  endAt?: Date;
}

const PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: SERIES_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

// Décalage (ms) entre l'heure murale de Paris et l'UTC à l'instant donné :
// +1h en hiver, +2h en été.
function parisOffsetMs(utcMs: number): number {
  const parts = Object.fromEntries(
    PARTS_FORMATTER.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - utcMs;
}

// Heure murale de Paris -> instant UTC. Deux passes : le décalage calculé
// sur la première estimation peut être celui de l'autre côté d'un
// changement d'heure, la seconde passe le corrige.
export function parisWallClockToUtc(date: string, time: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  const guess = Date.UTC(year, month - 1, day, hours, minutes);
  const firstOffset = parisOffsetMs(guess);
  let result = guess - firstOffset;
  const secondOffset = parisOffsetMs(result);
  if (secondOffset !== firstOffset) {
    result = guess - secondOffset;
  }
  return new Date(result);
}

// Fin de fenêtre EXCLUSIVE : même quantième N mois plus tard, ramené au
// dernier jour du mois s'il n'existe pas (31 janvier + 1 mois -> 28/29
// février, jamais un débordement sur mars).
function addMonthsClamped(year: number, monthIndex: number, day: number, months: number): number {
  const target = new Date(Date.UTC(year, monthIndex + months, 1));
  const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, daysInTarget));
}

function toIsoWeekday(utcDay: number): number {
  return utcDay === 0 ? 7 : utcDay;
}

function formatDateOnly(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;

// Occurrences triées chronologiquement, du startDate inclus à
// startDate + durationMonths exclu. Le parcours se fait sur des dates
// calendaires pures (minuit UTC, aucun fuseau) ; seule l'heure de chaque
// occurrence passe par Europe/Paris.
export function buildSeriesOccurrences(rule: SeriesRule): SeriesOccurrence[] {
  const [year, month, day] = rule.startDate.split("-").map(Number);
  const firstDay = Date.UTC(year, month - 1, day);
  const endExclusive = addMonthsClamped(year, month - 1, day, rule.durationMonths);
  const weekdays = new Set(rule.weekdays);

  const occurrences: SeriesOccurrence[] = [];
  for (let current = firstDay; current < endExclusive; current += DAY_MS) {
    if (!weekdays.has(toIsoWeekday(new Date(current).getUTCDay()))) continue;
    const date = formatDateOnly(current);
    occurrences.push({
      startAt: parisWallClockToUtc(date, rule.startTime),
      ...(rule.endTime ? { endAt: parisWallClockToUtc(date, rule.endTime) } : {}),
    });
  }
  return occurrences;
}

const WEEKDAY_LABELS_FR: Record<number, string> = {
  1: "lundi",
  2: "mardi",
  3: "mercredi",
  4: "jeudi",
  5: "vendredi",
  6: "samedi",
  7: "dimanche",
};

// "mercredi", "mardi et jeudi", "lundi, mercredi et vendredi" — ordre de la
// semaine, jamais l'ordre de saisie.
export function formatWeekdaysFr(weekdays: number[]): string {
  const labels = [...new Set(weekdays)].sort((a, b) => a - b).map((d) => WEEKDAY_LABELS_FR[d]);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} et ${labels[labels.length - 1]}`;
}
