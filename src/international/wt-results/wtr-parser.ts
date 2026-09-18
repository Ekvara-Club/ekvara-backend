import * as cheerio from "cheerio";

// Parsing PUR (aucun réseau, aucune DB) des pages HTML de World Taekwondo
// Results (https://results.worldtaekwondo.org, HTML rendu côté serveur — aucune
// API JSON observée, voir investigation #12A). Distinct du calendrier WT
// (www.worldtaekwondo.org, voir importers/world-taekwondo) : deux systèmes
// externes différents, deux jeux d'identifiants différents.

export const WT_RESULTS_SOURCE = "world_taekwondo_results";
export const WT_RESULTS_BASE_URL = "https://results.worldtaekwondo.org";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOC_RE = /^[A-Z]{3}$/;

export function competitionResultsUrl(slug: string): string {
  return `${WT_RESULTS_BASE_URL}/competitions/${slug}/results`;
}

export function matchUrl(slug: string, matchId: string): string {
  return `${WT_RESULTS_BASE_URL}/competitions/${slug}/results/${matchId}`;
}

export function profileUrl(athleteId: string): string {
  return `${WT_RESULTS_BASE_URL}/profile/${athleteId}`;
}

// ---------------------------------------------------------------------------
// Liste des compétitions (/competitions?year=YYYY)
// ---------------------------------------------------------------------------

export interface WtrCompetitionListItem {
  slug: string;
  name: string;
  dateStart: Date;
  dateEnd: Date;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Formats réellement observés : "4 Sep 2026", "5 - 7 Sep 2026",
// "1 Oct - 6 Oct 2014" (changement de mois). Toute autre forme est rejetée
// (null) plutôt que devinée.
export function parseWtrDateRange(text: string): { start: Date; end: Date } | null {
  const trimmed = text.trim();

  const single = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (single) {
    const date = buildUtcDate(single[3], single[2], single[1]);
    return date ? { start: date, end: date } : null;
  }

  const sameMonth = trimmed.match(/^(\d{1,2})\s*-\s*(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (sameMonth) {
    const start = buildUtcDate(sameMonth[4], sameMonth[3], sameMonth[1]);
    const end = buildUtcDate(sameMonth[4], sameMonth[3], sameMonth[2]);
    return start && end ? { start, end } : null;
  }

  const crossMonth = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s*-\s*(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (crossMonth) {
    const start = buildUtcDate(crossMonth[5], crossMonth[2], crossMonth[1]);
    const end = buildUtcDate(crossMonth[5], crossMonth[4], crossMonth[3]);
    return start && end ? { start, end } : null;
  }

  return null;
}

function buildUtcDate(year: string, monthName: string, day: string): Date | null {
  const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
  if (month === -1) return null;
  const date = new Date(Date.UTC(Number(year), month, Number(day)));
  // Rejette "31 Feb" plutôt que de laisser JavaScript déborder sur le mois suivant.
  if (Number.isNaN(date.getTime()) || date.getUTCMonth() !== month) return null;
  return date;
}

export function parseCompetitionList(html: string): WtrCompetitionListItem[] {
  const $ = cheerio.load(html);
  const items: WtrCompetitionListItem[] = [];

  $("tr").each((_, tr) => {
    const $tr = $(tr);
    const resultsHref = $tr.find('a[href*="/competitions/"][href$="/results"]').first().attr("href");
    const slug = resultsHref?.match(/\/competitions\/([a-z0-9-]+)\/results$/i)?.[1];
    if (!slug) return;

    const dateText = normalizeWhitespace($tr.find("td").first().text());
    const range = parseWtrDateRange(dateText);
    const name =
      normalizeWhitespace($tr.find("td").eq(2).text()) ||
      normalizeWhitespace($tr.find("img[alt]").first().attr("alt") ?? "");
    if (!range || !name) return;

    items.push({ slug, name, dateStart: range.start, dateEnd: range.end });
  });

  return items;
}

// ---------------------------------------------------------------------------
// Page résultats d'une compétition (/competitions/{slug}/results[?event=uuid])
// ---------------------------------------------------------------------------

export interface WtrCategoryOption {
  label: string;
  eventId: string;
}

export interface WtrResultsListing {
  categories: WtrCategoryOption[];
  matchIds: string[];
}

// La liste ne porte PAS les identifiants athlète (uniquement des noms) et ses
// colonnes stade/catégorie ne sont renseignées que sur la première ligne de
// chaque phase : elle ne sert qu'à découvrir les identifiants de match. La
// vérité (athlètes, orientation, score, vainqueur, stade, catégorie) vient de
// la page match.
export function parseResultsListing(html: string): WtrResultsListing {
  const $ = cheerio.load(html);

  const categories: WtrCategoryOption[] = [];
  $("select#weight option").each((_, option) => {
    const eventId = $(option).attr("value")?.trim() ?? "";
    const label = normalizeWhitespace($(option).text());
    if (UUID_RE.test(eventId) && label) categories.push({ label, eventId });
  });

  const seen = new Set<string>();
  const matchIds: string[] = [];
  $("tr[onclick]").each((_, tr) => {
    const onclick = $(tr).attr("onclick") ?? "";
    const id = onclick.match(/\/results\/([0-9a-f-]{36})/i)?.[1]?.toLowerCase();
    if (id && UUID_RE.test(id) && !seen.has(id)) {
      seen.add(id);
      matchIds.push(id);
    }
  });

  return { categories, matchIds };
}

// ---------------------------------------------------------------------------
// Page match (/competitions/{slug}/results/{matchId})
// ---------------------------------------------------------------------------

export interface WtrMatchAthlete {
  sourceId: string;
  name: string;
  countryCode: string | null;
  imageUrl: string | null;
}

export interface WtrMatch {
  sourceMatchId: string;
  competitionName: string | null;
  contestNumber: number | null;
  bracketStage: string | null;
  categoryLabel: string | null;
  athleteA: WtrMatchAthlete;
  athleteB: WtrMatchAthlete;
  scoreA: number | null;
  scoreB: number | null;
  // Vainqueur exposé par la source (classe CSS "winner" sur la cellule de
  // score) — jamais déduit de scoreA > scoreB.
  winner: "A" | "B" | null;
  resultMethod: string | null;
  resultMethodRaw: string | null;
}

export type WtrMatchParseResult =
  | { ok: true; match: WtrMatch; anomalies: string[] }
  | { ok: false; reason: string };

export function parseMatchPage(html: string, sourceMatchId: string): WtrMatchParseResult {
  if (!UUID_RE.test(sourceMatchId)) {
    return { ok: false, reason: `identifiant de match invalide: ${sourceMatchId}` };
  }

  const $ = cheerio.load(html);
  const anomalies: string[] = [];

  const columns = $("div.row.participants > div");
  if (columns.length !== 2) {
    return { ok: false, reason: `structure participants inattendue (${columns.length} colonne(s), 2 attendues)` };
  }

  const nameA = normalizeWhitespace(columns.eq(0).find("h3").first().text());
  const nameB = normalizeWhitespace(columns.eq(1).find("h3").first().text());
  if (!nameA || !nameB) {
    return { ok: false, reason: "nom d'un des deux athlètes absent" };
  }

  // Les liens profil suivent l'ordre A puis B dans le DOM (colonne gauche puis
  // colonne droite, comme les en-têtes). Pour ne jamais deviner quel UUID
  // appartient à quel athlète, chaque côté est confirmé par un NOM lu dans son
  // lien : le `alt` de la photo, ou — pour un athlète sans photo — le texte du
  // placeholder ("?text=SURNAME Given"), comparés sans tenir compte de l'ordre
  // des mots. Règles :
  //   - un nom qui CONTREDIT l'en-tête ⇒ match refusé ;
  //   - aucun côté confirmable ⇒ match refusé ;
  //   - au moins un côté confirmé et aucune contradiction ⇒ accepté : les deux
  //     UUID étant distincts, le côté confirmé fixe aussi l'autre.
  const links = $("a.btn-profile")
    .map((_, a) => {
      const href = $(a).attr("href") ?? "";
      const id = href.match(/\/profile\/([0-9a-f-]{36})\/?$/i)?.[1]?.toLowerCase() ?? null;
      const img = $(a).find("img.photo").first();
      const src = img.attr("src")?.trim() || null;
      return { id, alt: normalizeWhitespace(img.attr("alt") ?? ""), src };
    })
    .get();

  if (links.length !== 2 || !links[0].id || !links[1].id || !UUID_RE.test(links[0].id) || !UUID_RE.test(links[1].id)) {
    return { ok: false, reason: `liens profil inattendus (${links.length} lien(s) exploitable(s), 2 attendus)` };
  }
  if (links[0].id === links[1].id) {
    return { ok: false, reason: "les deux liens profil désignent le même athlète" };
  }

  const confirmations = [confirmSide(links[0], nameA), confirmSide(links[1], nameB)];
  if (confirmations.includes("contradiction")) {
    return {
      ok: false,
      reason: `orientation non vérifiable : le nom d'un lien profil contredit l'en-tête ("${nameA}" / "${nameB}")`,
    };
  }
  if (confirmations.every((c) => c === "unconfirmed")) {
    return {
      ok: false,
      reason: `orientation non vérifiable : aucun nom de confirmation dans les liens profil ("${nameA}" / "${nameB}")`,
    };
  }

  const countryA = readNoc(columns.eq(0).find(".flag span").first().text(), anomalies, "A");
  const countryB = readNoc(columns.eq(1).find(".flag span").first().text(), anomalies, "B");

  // "Contest Result 326 (QF) / Women -73kg"
  const title = normalizeWhitespace($("h2.table-title").first().text());
  const titleMatch = title.match(/^Contest Result\s+(\d+)?\s*(?:\(([^)]+)\))?\s*\/?\s*(.*)$/i);
  const contestNumber = titleMatch?.[1] ? Number(titleMatch[1]) : null;
  const bracketStage = titleMatch?.[2]?.trim() || null;
  const categoryLabel = titleMatch?.[3]?.trim() || null;
  if (!titleMatch) anomalies.push(`titre du match non reconnu: "${title}"`);

  const scoreRow = $("tr.match-detail-score.final-score").first();
  const value1 = scoreRow.find(".match-detail-value1").first();
  const value2 = scoreRow.find(".match-detail-value2").first();
  const scoreA = parseScore(value1.text());
  const scoreB = parseScore(value2.text());

  const aWins = value1.hasClass("winner");
  const bWins = value2.hasClass("winner");
  let winner: "A" | "B" | null = null;
  if (aWins && bWins) {
    anomalies.push("les deux athlètes sont marqués vainqueurs — vainqueur non retenu");
  } else if (aWins) {
    winner = "A";
  } else if (bWins) {
    winner = "B";
  }

  // "Won by PTF" est affiché dans la colonne du VAINQUEUR (1ʳᵉ cellule si A gagne,
  // 3ᵉ si B gagne) : on lit donc toutes les cellules de la ligne, jamais
  // seulement la première (bug constaté sur des pages réelles où B gagne).
  const methodCells = $("tr.match-detail-won th")
    .map((index, th) => ({ index, text: normalizeWhitespace($(th).text()) }))
    .get()
    .filter((cell) => cell.text !== "");
  if (methodCells.length > 1) {
    anomalies.push(`plusieurs cellules de méthode renseignées: ${methodCells.map((c) => `"${c.text}"`).join(", ")}`);
  }
  const methodRaw = methodCells[0]?.text ?? null;
  const methodSide = methodCells[0] ? (methodCells[0].index === 0 ? "A" : methodCells[0].index === 2 ? "B" : null) : null;
  if (methodSide !== null && winner !== null && methodSide !== winner) {
    anomalies.push(`méthode de victoire affichée du côté ${methodSide} alors que le vainqueur marqué est ${winner}`);
  }
  const methodCode = methodRaw?.match(/^Won by\s+([A-Za-z]{2,6})$/i)?.[1]?.toUpperCase() ?? null;
  if (methodRaw && !methodCode) anomalies.push(`méthode de victoire non reconnue: "${methodRaw}"`);

  if (winner === null && (scoreA !== null || scoreB !== null)) {
    anomalies.push("score présent mais aucun vainqueur exposé par la source");
  }
  if (methodCode === "PTF" && winner !== null && scoreA !== null && scoreB !== null) {
    const winnerScore = winner === "A" ? scoreA : scoreB;
    const loserScore = winner === "A" ? scoreB : scoreA;
    if (winnerScore <= loserScore) {
      anomalies.push(`victoire aux points (PTF) avec un score vainqueur non supérieur (${scoreA}-${scoreB})`);
    }
  }

  return {
    ok: true,
    anomalies,
    match: {
      sourceMatchId: sourceMatchId.toLowerCase(),
      competitionName: normalizeWhitespace($("h1 span").first().text()) || null,
      contestNumber,
      bracketStage,
      categoryLabel,
      athleteA: { sourceId: links[0].id, name: nameA, countryCode: countryA, imageUrl: realPhotoUrl(links[0].src) },
      athleteB: { sourceId: links[1].id, name: nameB, countryCode: countryB, imageUrl: realPhotoUrl(links[1].src) },
      scoreA,
      scoreB,
      winner,
      resultMethod: methodCode,
      resultMethodRaw: methodRaw,
    },
  };
}

// ---------------------------------------------------------------------------
// Profil athlète (/profile/{uuid})
// ---------------------------------------------------------------------------

export interface WtrProfile {
  sourceId: string;
  displayName: string;
  countryCode: string | null;
  imageUrl: string | null;
  // Record affiché par la source ("53 / 13 (80.3%)") : snapshot, jamais
  // recalculé. null si absent ou "-".
  recordWins: number | null;
  recordLosses: number | null;
}

export type WtrProfileParseResult =
  | { ok: true; profile: WtrProfile; anomalies: string[] }
  | { ok: false; reason: string };

export function parseProfilePage(html: string, sourceId: string): WtrProfileParseResult {
  if (!UUID_RE.test(sourceId)) {
    return { ok: false, reason: `identifiant athlète invalide: ${sourceId}` };
  }

  const $ = cheerio.load(html);
  const anomalies: string[] = [];

  const header = $("h1")
    .filter((_, el) => /athlete profile/i.test($(el).text()))
    .first();
  if (header.length === 0) {
    return { ok: false, reason: "page profil non reconnue (titre « Athlete Profile » absent)" };
  }

  const container = header.parent();
  const displayName = normalizeWhitespace(container.find("h2").first().text());
  if (!displayName) {
    return { ok: false, reason: "nom de l'athlète absent" };
  }

  const nocText = normalizeWhitespace(container.find(".flag span").first().text());
  const countryCode = NOC_RE.test(nocText) ? nocText : null;
  if (!countryCode) anomalies.push(`code NOC absent ou invalide: "${nocText}"`);

  const imageUrl = realPhotoUrl(container.find("img.photo").first().attr("src")?.trim() || null);

  let recordWins: number | null = null;
  let recordLosses: number | null = null;
  container.find("dl dt").each((_, dt) => {
    if (normalizeWhitespace($(dt).text()).toLowerCase() !== "record (win / lose)") return;
    const value = normalizeWhitespace($(dt).next("dd").text());
    const m = value.match(/^(\d+)\s*\/\s*(\d+)/);
    if (m) {
      recordWins = Number(m[1]);
      recordLosses = Number(m[2]);
    } else if (value !== "-" && value !== "") {
      anomalies.push(`record V/D non reconnu: "${value}"`);
    }
  });

  return {
    ok: true,
    anomalies,
    profile: { sourceId: sourceId.toLowerCase(), displayName, countryCode, imageUrl, recordWins, recordLosses },
  };
}

// ---------------------------------------------------------------------------

type SideConfirmation = "name" | "unconfirmed" | "contradiction";

function confirmSide(link: { alt: string; src: string | null }, headerName: string): SideConfirmation {
  if (link.alt) {
    return sameNameTokens(link.alt, headerName) ? "name" : "contradiction";
  }
  // Athlète sans photo : le site sert un placeholder "…?text=SURNAME Given".
  const placeholder = link.src?.match(/[?&]text=([^&]+)/)?.[1];
  if (placeholder) {
    return sameNameTokens(safeDecode(placeholder), headerName) ? "name" : "contradiction";
  }
  return "unconfirmed";
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

// Comparaison de noms insensible à la casse, aux accents, à la ponctuation ET
// à l'ordre des mots ("ISMAILOV Ismail" ≡ "Ismail ISMAILOV").
function sameNameTokens(a: string, b: string): boolean {
  const tokens = (name: string) =>
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean)
      .sort()
      .join(" ");
  return tokens(a) === tokens(b);
}

// Seules les vraies photos hébergées par la source comptent : les athlètes sans
// photo reçoivent un placeholder tiers (placehold.co) qui ne doit JAMAIS être
// stocké comme photo de l'athlète.
function realPhotoUrl(src: string | null): string | null {
  return src && src.startsWith(`${WT_RESULTS_BASE_URL}/storage/photos/`) ? src : null;
}

function readNoc(rawText: string, anomalies: string[], side: "A" | "B"): string | null {
  const text = normalizeWhitespace(rawText);
  if (NOC_RE.test(text)) return text;
  anomalies.push(`code NOC absent ou invalide pour l'athlète ${side}: "${text}"`);
  return null;
}

function parseScore(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
