import { ImportedCompetition } from "./imported-competition.interface";

export interface FftdaCalendarItem {
  _id: number;
  type?: string;
  name: string;
  start: string;
  end?: string;
  address?: { text?: string };
  content?: string;
}

export interface FftdaCalendarResponse {
  items: FftdaCalendarItem[];
}

const COMPETITION_KEYWORDS = [
  "championnat",
  "chpt",
  "coupe",
  "cpe",
  "open",
  "tournoi",
  "critérium",
  "criterium",
  "crit.",
  "grand prix",
  "cup",
  "trophée",
  "trophee",
];

// Formations, réunions fédérales, stages, examens : jamais des compétitions.
const NON_COMPETITION_KEYWORDS = [
  "formation",
  "réunion",
  "reunion",
  "stage",
  "examen",
  "séminaire",
  "seminaire",
  "assemblée",
  "assemblee",
  "bureau",
  "comité directeur",
  "comite directeur",
  "conseil",
  "csdge",
  "passage",
  "gestion des compétitions",
  "gestion des competitions",
];

const STREET_PREFIXES = [
  "rue",
  "avenue",
  "boulevard",
  "bd",
  "chemin",
  "stade",
  "allée",
  "allee",
  "place",
  "route",
  "cours",
  "impasse",
  "quai",
  "zac",
  "insep",
  "centre",
  "gymnase",
  "complexe",
  "salle",
  "espace",
  "ufr",
  "aréna",
  "arena",
];

export function isCompetition(item: FftdaCalendarItem): boolean {
  const name = item.name.toLowerCase();

  // Le blocklist ne porte que sur le nom : le contenu HTML libre des événements
  // peut légitimement mentionner "réunion" (ex: briefing zoom) ou "information"
  // sans que l'événement soit lui-même une réunion administrative.
  if (matchesAny(name, NON_COMPETITION_KEYWORDS)) {
    return false;
  }

  if (matchesAny(name, COMPETITION_KEYWORDS)) {
    return true;
  }

  // Filet de sécurité : nature compétitive parfois seulement identifiable dans le contenu.
  const content = (item.content ?? "").toLowerCase();
  return matchesAny(content, COMPETITION_KEYWORDS);
}

export function normalizeFftdaItem(item: FftdaCalendarItem): ImportedCompetition | null {
  if (!item.name?.trim()) {
    return null;
  }

  const dateDebut = parseDate(item.start);
  if (!dateDebut) {
    return null;
  }

  let dateFin: Date | undefined;
  if (item.end) {
    const parsedEnd = parseDate(item.end);
    if (!parsedEnd) {
      return null;
    }
    if (parsedEnd.getTime() !== dateDebut.getTime()) {
      dateFin = parsedEnd;
    }
  }

  const addressText = item.address?.text?.trim();
  const { ville, pays } = addressText ? parseLocation(addressText) : {};

  return {
    source: "fftda",
    sourceExternalId: String(item._id),
    nom: item.name.trim(),
    dateDebut,
    dateFin,
    lieu: addressText || undefined,
    ville,
    pays,
    niveau: item.type || undefined,
  };
}

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => new RegExp(`\\b${escapeRegExp(kw)}\\b`).test(text));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Les dates FFTDA sont des ISO datetimes avec offset (ex: "2027-06-27T00:00:00+02:00").
// On extrait le jour calendaire tel qu'affiché dans la chaîne plutôt que de laisser
// le fuseau du serveur décaler la date lors de la conversion en Date.
function parseDate(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseLocation(addressText: string): { ville?: string; pays?: string } {
  const frenchPostal = addressText.match(/(\d{5})\s+([^,]+)/);
  if (frenchPostal) {
    return { ville: frenchPostal[2].trim(), pays: "France" };
  }

  const segments = addressText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return {};
  }

  const firstSegment = segments[0];
  const looksLikeStreet =
    /^\d/.test(firstSegment) ||
    STREET_PREFIXES.some((prefix) => firstSegment.toLowerCase().startsWith(prefix));
  const ville = !looksLikeStreet ? firstSegment : undefined;

  let pays: string | undefined;
  if (segments.length > 1) {
    const lastSegment = segments[segments.length - 1];
    if (lastSegment.toLowerCase() === "france") {
      pays = "France";
    } else if (/^[A-ZÀ-Ü][A-Za-zÀ-ÿ\-\s]{1,30}$/.test(lastSegment)) {
      pays = lastSegment;
    }
  }

  return { ville, pays };
}
