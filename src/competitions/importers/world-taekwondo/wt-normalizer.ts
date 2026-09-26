import * as cheerio from "cheerio";
import { CalendarDivision, ImportedCompetition } from "../imported-competition.interface";

// Un événement du calendrier WT est identifié par sa ligne <tr> "ancre" (celle qui
// porte le lien a.listView avec le detailsKey). Cette ligne contient, grâce à
// rowspan, le titre et le lieu — les lignes suivantes sans lien listView sont des
// sous-catégories (Senior/Junior/Cadet...) qui ne répètent que la date.
export interface WtRawEvent {
  detailsKey: string;
  title: string;
  location: string;
  dateTexts: string[];
  // Une entrée par ligne source (ancre puis sous-lignes, ordre de la page) :
  // texte brut des colonnes Date et Discipline. Optionnel pour ne pas imposer
  // les divisions aux appelants qui construisent un WtRawEvent à la main.
  rows?: WtRawRow[];
}

export interface WtRawRow {
  dateText: string;
  discipline: string;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

export function parseWtCalendarPage(html: string): WtRawEvent[] {
  const $ = cheerio.load(html);
  const events: WtRawEvent[] = [];

  $("a.listView").each((_, el) => {
    const $link = $(el);
    const detailsKey = $link.attr("data-details-key");
    if (!detailsKey) {
      return;
    }

    const title = $link.text().trim();
    const anchorTr = $link.closest("tr");
    const tds = anchorTr.find("> td");
    const firstDateText = normalizeWhitespace(tds.eq(0).text());
    const locationText = normalizeWhitespace(tds.eq(5).text());

    const dateTexts = firstDateText ? [firstDateText] : [];
    const rows: WtRawRow[] = [{ dateText: firstDateText, discipline: normalizeWhitespace(tds.eq(1).text()) }];

    // Les sous-catégories (Senior/Junior/Cadet...) partagent le titre et le lieu
    // de la ligne ancre via rowspan : elles n'apportent qu'une date supplémentaire.
    let sibling = anchorTr.next("tr");
    while (sibling.length > 0 && sibling.find("a.listView").length === 0) {
      const siblingTds = sibling.find("> td");
      const siblingDate = normalizeWhitespace(siblingTds.eq(0).text());
      rows.push({ dateText: siblingDate, discipline: normalizeWhitespace(siblingTds.eq(1).text()) });
      if (siblingDate) {
        dateTexts.push(siblingDate);
      }
      sibling = sibling.next("tr");
    }

    events.push({ detailsKey, title, location: locationText, dateTexts, rows });
  });

  return events;
}

export function normalizeWtEvent(event: WtRawEvent, year: number): ImportedCompetition | null {
  if (!event.title || !event.detailsKey) {
    return null;
  }

  const ranges = event.dateTexts
    .map((text) => parseDateRange(text, year))
    .filter((r): r is { start: Date; end: Date } => r !== null);

  if (ranges.length === 0) {
    return null;
  }

  const allDates = ranges.flatMap((r) => [r.start, r.end]);
  const dateDebut = new Date(Math.min(...allDates.map((d) => d.getTime())));
  const dateFinCandidate = new Date(Math.max(...allDates.map((d) => d.getTime())));
  const dateFin = dateFinCandidate.getTime() !== dateDebut.getTime() ? dateFinCandidate : undefined;

  const { ville, pays } = splitLocation(event.location);

  return {
    source: "world_taekwondo",
    sourceExternalId: event.detailsKey,
    nom: event.title,
    dateDebut,
    dateFin,
    ville,
    pays,
    niveau: "international",
    ...(event.rows ? { divisions: event.rows.map((row) => toDivision(row, year)) } : {}),
  };
}

// Colonne Discipline conservée telle que publiée (jamais interprétée ici :
// Kyorugi/Poomsae/tranche d'âge restent du texte source). Les dates sont
// dérivées par le même parseDateRange que date_debut/date_fin, null si le
// texte n'est pas reconnu (ex. "June 4 Virtual Taekwondo") — jamais devinées.
function toDivision(row: WtRawRow, year: number): CalendarDivision {
  const range = row.dateText ? parseDateRange(row.dateText, year) : null;
  return {
    dateText: row.dateText,
    discipline: row.discipline || null,
    start: range ? isoDay(range.start) : null,
    end: range ? isoDay(range.end) : null,
  };
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Formats rencontrés dans le calendrier WT : "February 3", "February 1-2",
// "April 12 - 17" (espaces autour du tiret) et, potentiellement, un changement de
// mois du type "April 30 - May 2". Toute variation non reconnue (fautes de frappe
// telles que "Feburary", texte additionnel comme "Virtual Taekwondo") est rejetée
// plutôt que devinée.
function parseDateRange(text: string, year: number): { start: Date; end: Date } | null {
  const match = text
    .trim()
    .match(/^([A-Za-z]+)\s+(\d{1,2})(?:\s*-\s*(?:([A-Za-z]+)\s+)?(\d{1,2}))?$/);
  if (!match) {
    return null;
  }

  const [, startMonthName, startDay, endMonthName, endDay] = match;

  const start = buildUtcDate(startMonthName, startDay, year);
  if (!start) {
    return null;
  }

  if (!endDay) {
    return { start, end: start };
  }

  const end = buildUtcDate(endMonthName ?? startMonthName, endDay, year);
  if (!end) {
    return null;
  }

  return { start, end };
}

function buildUtcDate(monthName: string, day: string, year: number): Date | null {
  const month = MONTHS.indexOf(monthName.toLowerCase());
  if (month === -1) {
    return null;
  }
  const date = new Date(Date.UTC(year, month, Number(day)));
  // Rejette les jours hors plage (ex: "February 30") plutôt que de laisser
  // JavaScript déborder silencieusement sur le mois suivant.
  if (Number.isNaN(date.getTime()) || date.getUTCMonth() !== month) {
    return null;
  }
  return date;
}

function splitLocation(text: string): { ville?: string; pays?: string } {
  const parts = text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return {};
  }
  if (parts.length === 1) {
    return { ville: parts[0] };
  }
  return { ville: parts[0], pays: parts.slice(1).join(", ") };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
