import * as cheerio from "cheerio";
import { ImportedCompetition } from "../imported-competition.interface";

// POC (voir ticket import Martial Events) : fonctions pures de parsing/normalisation,
// jamais d'accès réseau ici (voir me-importer.service.ts) — testables avec de simples
// chaînes HTML, sans dépendre du site en direct.
//
// Deux pages HTML publiques sont utilisées :
// - la page événement (ex. /fr/events/<slug>) : microdonnées schema.org/Event déjà
//   présentes dans le HTML initial (pas de JS nécessaire) ;
// - le fragment /entries, chargé par le site lui-même en AJAX (data-toggle="tab-ajax")
//   et donc récupérable directement en HTTP : une <table> par catégorie, avec un
//   <caption> (libellé + compteur affiché) et une ligne <tr> par inscrit.

export interface MartialEventsEntry {
  name: string;
  club: string | null;
  league: string | null;
  country: string | null;
}

// Format conceptuel demandé par le ticket, jamais un contrat imposé : ageCategory/
// gender/weightCategory restent `null` dès que l'interprétation n'est pas certaine —
// rawLabel est TOUJOURS conservé tel quel, quoi qu'il arrive.
export interface MartialEventsCategoryLabel {
  rawLabel: string;
  ageCategory: string | null;
  gender: "male" | "female" | null;
  weightCategory: string | null;
}

export interface MartialEventsCategoryEntries {
  category: MartialEventsCategoryLabel;
  entries: MartialEventsEntry[];
}

// Catégories d'âge officielles françaises de taekwondo (FFTDA) : normalisation par
// table de correspondance fermée plutôt que par un algorithme de singularisation —
// jamais de déduction hasardeuse sur un mot inconnu.
const AGE_CATEGORY_LABELS: Record<string, string> = {
  poussins: "Poussin",
  benjamins: "Benjamin",
  minimes: "Minime",
  cadets: "Cadet",
  juniors: "Junior",
  espoirs: "Espoir",
  seniors: "Senior",
  masters: "Master",
};

const GENDER_PATTERNS: { pattern: RegExp; value: "male" | "female" }[] = [
  { pattern: /\bmasculins?\b/i, value: "male" },
  { pattern: /\bféminin(?:e|es)?\b/i, value: "female" },
];

// --- Compétition (métadonnées) ---------------------------------------------------

export function normalizeMartialEventsCompetition(html: string): ImportedCompetition | null {
  const $ = cheerio.load(html);
  const root = $('[itemtype="http://schema.org/Event"]').first();
  if (root.length === 0) {
    return null;
  }

  const sourceExternalId = extractExternalId(root.attr("class"));
  if (!sourceExternalId) {
    return null;
  }

  const nom = root.find('[itemprop="name"]').first().text().trim();
  if (!nom) {
    return null;
  }

  const dateDebut = parseIsoDate(root.find('meta[itemprop="startDate"]').first().attr("content"));
  if (!dateDebut) {
    return null;
  }

  const dateFinParsed = parseIsoDate(root.find('meta[itemprop="endDate"]').first().attr("content"));
  const dateFin =
    dateFinParsed && dateFinParsed.getTime() !== dateDebut.getTime() ? dateFinParsed : undefined;

  // Le bloc lieu (schema.org/Place) est un microdata séparé, potentiellement absent
  // pour un événement sans adresse renseignée — jamais de valeur inventée si absent.
  const addressFull = $('[itemtype="http://schema.org/Place"] meta[itemprop="address"]')
    .first()
    .attr("content")
    ?.trim();
  const { ville, pays } = addressFull ? parseAddress(addressFull) : {};

  // Unique <dl> observé sur la page, dans le panneau "Contact de l'organisation" —
  // structurellement stable (même position sur les deux événements réels inspectés),
  // mais reste un point fragile si le site change cette mise en page (voir rapport).
  const organisateur = $("dl dt").first().text().trim() || undefined;

  return {
    source: "martial_events",
    sourceExternalId,
    nom,
    dateDebut,
    dateFin,
    lieu: addressFull || undefined,
    ville,
    pays,
    organisateur,
    // niveau : aucun champ structuré explicite observé sur la source (contrairement
    // à `item.type` pour FFTDA) — jamais déduit du seul titre libre ("Championnat de
    // France..." pourrait suggérer "national", mais ce serait une supposition, pas
    // une donnée réellement disponible).
  };
}

function extractExternalId(classAttr: string | undefined): string | null {
  const match = (classAttr ?? "").match(/\bevent-(\d+)\b/);
  return match ? match[1] : null;
}

function parseIsoDate(value: string | undefined): Date | null {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isNaN(date.getTime()) ? null : date;
}

// Format observé (2/2 événements réels inspectés) : "Nom du lieu, Adresse, Code
// postal, Ville, Pays" — ville et pays sont toujours les deux derniers segments,
// quel que soit le nombre de segments qui précèdent (nom de lieu et rue peuvent
// eux-mêmes contenir des virgules additionnelles).
function parseAddress(addressFull: string): { ville?: string; pays?: string } {
  const segments = addressFull
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length === 0) return {};
  if (segments.length === 1) return { ville: segments[0] };

  return {
    ville: segments[segments.length - 2],
    pays: segments[segments.length - 1],
  };
}

// --- Catégories / inscrits (page /entries) ----------------------------------------

// Une catégorie = une <table> avec un <caption> direct (structure sémantique stable),
// jamais identifiée par un id/une classe spécifique à une compétition donnée.
export function parseMartialEventsEntriesFragment(html: string): MartialEventsCategoryEntries[] {
  const $ = cheerio.load(html);
  const categories: MartialEventsCategoryEntries[] = [];

  $("table").each((_, tableEl) => {
    const $table = $(tableEl);
    const $caption = $table.find("> caption").first();
    if ($caption.length === 0) {
      return;
    }

    const rawLabel = extractCaptionLabel($, $caption);
    if (!rawLabel) {
      return;
    }

    const entries = parseCategoryRows($, $table);

    categories.push({
      category: normalizeCategoryLabel(rawLabel),
      entries,
    });
  });

  return categories;
}

// Le <caption> contient aussi un compteur affiché par le site (ex. "...28
// inscriptions28 inscrits") : jamais utilisé comme source de vérité — le nombre réel
// d'inscrits est toujours le nombre de lignes effectivement parsées ci-dessous.
function extractCaptionLabel($: cheerio.CheerioAPI, $caption: cheerio.Cheerio<any>): string {
  const clone = $caption.clone();
  clone.find("span").remove();
  return normalizeWhitespace(clone.text());
}

function parseCategoryRows($: cheerio.CheerioAPI, $table: cheerio.Cheerio<any>): MartialEventsEntry[] {
  const entries: MartialEventsEntry[] = [];

  $table.find("> tbody > tr").each((_, rowEl) => {
    const cells = $(rowEl).find("> td");
    // No. / Nom / Équipe / [Pays] : une ligne avec moins de 3 colonnes est
    // structurellement incomplète et ignorée plutôt qu'interprétée au hasard.
    if (cells.length < 3) {
      return;
    }

    const nameCell = $(cells[1]);
    const name = extractTextExcludingNestedDivs($, nameCell);
    if (!name) {
      return;
    }

    const clubCell = $(cells[2]);
    const leagueDiv = clubCell.find("div").first();
    const league = leagueDiv.length > 0 ? normalizeWhitespace(leagueDiv.text()) || null : null;
    const club = extractTextExcludingNestedDivs($, clubCell) || null;

    const country = cells.length > 3 ? normalizeWhitespace($(cells[3]).text()) || null : null;

    entries.push({ name, club, league, country });
  });

  return entries;
}

// Retire tout <div> imbriqué (ligue, statut "en attente paiement"...) avant
// d'extraire le texte propre de la cellule — générique, jamais une liste de
// libellés de statut codés en dur.
function extractTextExcludingNestedDivs($: cheerio.CheerioAPI, cell: cheerio.Cheerio<any>): string {
  const clone = cell.clone();
  clone.find("div").remove();
  return normalizeWhitespace(clone.text());
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// --- Normalisation prudente du libellé de catégorie -------------------------------

export function normalizeCategoryLabel(rawLabel: string): MartialEventsCategoryLabel {
  const trimmed = rawLabel.trim();
  const lower = trimmed.toLowerCase();

  let ageCategory: string | null = null;
  for (const [key, label] of Object.entries(AGE_CATEGORY_LABELS)) {
    if (new RegExp(`\\b${key}\\b`, "i").test(lower)) {
      ageCategory = label;
      break;
    }
  }

  const genderMatch = GENDER_PATTERNS.find((g) => g.pattern.test(lower));
  const gender = genderMatch ? genderMatch.value : null;

  const weightMatch = trimmed.match(/([+-])\s?(\d{2,3})\s?kg/i);
  const weightCategory = weightMatch ? `${weightMatch[1]}${weightMatch[2]} kg` : null;

  return { rawLabel: trimmed, ageCategory, gender, weightCategory };
}
