// Rapprochement PUR (aucun réseau, aucune DB) entre une compétition du site
// World Taekwondo Results (identifiant = slug) et une compétition canonique
// EKVARA déjà connue via le CALENDRIER WT (competition_source.source =
// "world_taekwondo", identifiant numérique). Les deux identifiants sont
// différents et ne sont jamais mélangés : ce matcher ne fait que décider s'il
// est SÛR d'attacher une source supplémentaire "world_taekwondo_results" à la
// MÊME competition canonique.
//
// Volontairement séparé de matching/competition-matcher.ts (FFTDA ↔ Martial
// Events, logique inchangée) : signaux différents, et ici aucun niveau
// "fuzzy" — un rattachement n'est autorisé que si TOUT ce qui suit est vrai :
//
//   1. dates identiques : même date de début ET même date de fin (une
//      date_fin absente côté EKVARA vaut la date de début) ;
//   2. noms fortement compatibles : après normalisation (minuscules, sans
//      accents ni apostrophes, ponctuation → espace) et retrait des mots
//      génériques WT (GENERIC_TOKENS), les deux ensembles de mots restants
//      sont ÉGAUX (pas seulement proches) et contiennent au moins
//      MIN_DISTINCTIVE_TOKENS mots — un nom trop générique ne suffit jamais ;
//   3. aucune ambiguïté : exactement UNE compétition canonique candidate
//      satisfait 1 et 2, et aucune AUTRE compétition Results de la même liste
//      ne satisfait 1 et 2 pour la même candidate (sinon deux slugs se
//      disputeraient une même compétition).
//
// Tout le reste ⇒ pas de rattachement. Le nom seul ne suffit jamais (date
// obligatoire), la date seule non plus (nom obligatoire).

export type WtrMappingVerdict = "SAFE" | "AMBIGUOUS" | "UNMATCHED";

export interface WtrCompetitionRef {
  slug: string;
  name: string;
  dateStart: Date;
  dateEnd: Date;
}

export interface CalendarCandidate {
  competitionId: string;
  nom: string;
  dateDebut: Date;
  dateFin: Date | null;
}

export interface WtrMappingResult {
  verdict: WtrMappingVerdict;
  // Renseigné uniquement pour SAFE.
  competitionId: string | null;
  reasons: string[];
  normalizedName: string;
}

// Mots qui ne distinguent pas une compétition d'une autre dans les noms WT.
// "series" : le calendrier WT écrit "Grand Prix Series" là où Results écrit
// "Grand-Prix" pour la même compétition (cas réel Roma 2026, mêmes dates).
// Volontairement PAS génériques : "para" (World Para Taekwondo Grand Prix est
// une autre compétition, mêmes lieux/dates proches), "junior", "cadet",
// "poomsae", "open", "championships"... tout ce qui distingue vraiment.
const GENERIC_TOKENS = new Set(["world", "taekwondo", "wt", "series", "the", "of", "and", "de", "du", "la", "le"]);

// Année calendaire (4 chiffres) : jamais distinctive une fois les dates exactes
// déjà vérifiées par ailleurs (règle 1 de mapResultsCompetition ci-dessus) —
// prouvé sûr par simulation #12I-A sur 175 compétitions canoniques × 108
// événements Results (2025+2026) : gain 12, 0 collision, 0 SAFE modifié.
// Même pattern que matching/competition-matcher.ts::significantTokens().
const YEAR_TOKEN = /^\d{4}$/;

// Numéro d'édition ordinal ("12th", "1st", "33rd"...) : redondant avec la date
// exacte déjà vérifiée, jamais utilisé pour distinguer deux compétitions à la
// même date — prouvé sûr par simulation #12I-A (même corpus, gain incrémental
// 1, 0 collision, 0 SAFE modifié). Le token est retiré entièrement (jamais
// réduit à un nombre nu) car #12I-A n'a validé que le retrait, pas une
// transformation numérique.
const ORDINAL_TOKEN = /^\d+(st|nd|rd|th)$/;

const MIN_DISTINCTIVE_TOKENS = 2;

export function normalizeCompetitionName(name: string): string {
  return distinctiveTokens(name).join(" ");
}

export function mapResultsCompetition(
  results: WtrCompetitionRef,
  candidates: CalendarCandidate[],
  otherResultsCompetitions: WtrCompetitionRef[] = [],
): WtrMappingResult {
  const normalizedName = normalizeCompetitionName(results.name);
  const tokens = distinctiveTokens(results.name);
  const base = { normalizedName };

  if (tokens.length < MIN_DISTINCTIVE_TOKENS) {
    return {
      ...base,
      verdict: "UNMATCHED",
      competitionId: null,
      reasons: [`nom Results trop générique après normalisation ("${normalizedName}")`],
    };
  }

  const sameDates = candidates.filter((c) => sameDay(results.dateStart, c.dateDebut) && sameDay(results.dateEnd, c.dateFin ?? c.dateDebut));

  if (sameDates.length === 0) {
    return {
      ...base,
      verdict: "UNMATCHED",
      competitionId: null,
      reasons: ["aucune compétition canonique WT avec exactement les mêmes dates de début et de fin"],
    };
  }

  const strong = sameDates.filter((c) => sameTokenSet(tokens, distinctiveTokens(c.nom)));

  if (strong.length === 0) {
    return {
      ...base,
      verdict: "UNMATCHED",
      competitionId: null,
      reasons: [
        "dates identiques mais aucun nom suffisamment compatible (ensembles de mots distinctifs différents)",
        ...sameDates.map((c) => `candidat écarté: "${c.nom}" → "${normalizeCompetitionName(c.nom)}"`),
      ],
    };
  }

  if (strong.length > 1) {
    return {
      ...base,
      verdict: "AMBIGUOUS",
      competitionId: null,
      reasons: [`${strong.length} compétitions canoniques candidates (mêmes dates, mêmes mots distinctifs): ${strong.map((c) => c.competitionId).join(", ")}`],
    };
  }

  const rivals = otherResultsCompetitions.filter(
    (other) =>
      other.slug !== results.slug &&
      sameDay(other.dateStart, results.dateStart) &&
      sameDay(other.dateEnd, results.dateEnd) &&
      sameTokenSet(tokens, distinctiveTokens(other.name)),
  );
  if (rivals.length > 0) {
    return {
      ...base,
      verdict: "AMBIGUOUS",
      competitionId: null,
      reasons: [`une autre compétition Results satisfait aussi ces critères pour la même candidate: ${rivals.map((r) => r.slug).join(", ")}`],
    };
  }

  const target = strong[0];
  return {
    ...base,
    verdict: "SAFE",
    competitionId: target.competitionId,
    reasons: [
      "dates de début et de fin identiques",
      `ensemble de mots distinctifs identique: ${tokens.join(", ")}`,
      "une seule candidate, aucun concurrent Results",
    ],
  };
}

// ---------------------------------------------------------------------------
// #22 — Rapprochement par DIVISIONS du calendrier (Results uniquement).
//
// Utilisé SEULEMENT quand la règle exacte ci-dessus a répondu UNMATCHED : WT
// Results publie souvent un seul jour (ex. le jour Senior) alors que le
// calendrier publie l'événement entier (Cadet 4 juin, Junior 5, Senior 6-7).
// Un rattachement n'est autorisé que si TOUT ce qui suit est vrai :
//
//   1. nom : même ensemble de mots distinctifs que la règle exacte ;
//   2. discipline Results PROUVÉE Kyorugi (toutes ses catégories sont des
//      catégories de poids — voir resultsDisciplineFromCategories) ;
//   3. la plage Results est entièrement CONTENUE dans la plage canonique ;
//   4. chaque jour Results est couvert par une division calendrier dont la
//      source écrit explicitement "Kyorugi" (une entrée Poomsae seule, ou une
//      division sans discipline déclarée comme "Senior" en 2025, ne prouve
//      rien et n'est jamais interprétée) ;
//   5. exactement UNE candidate remplit 1-4, aucune autre candidate homonyme
//      contenant la plage ne reste indécidable (divisions absentes/illisibles
//      ou non déclarées), et aucun AUTRE événement Results homonyme ne tombe
//      dans la plage de la candidate retenue.
//
// Validé par simulation #22 (175 canoniques × 109 Results 2025-2026 +
// contrôles négatifs) : 0 SAFE modifié, 0 nouvelle ambiguïté, 0 collision.
// ---------------------------------------------------------------------------

export type ResultsDiscipline = "KYORUGI" | "UNKNOWN";
export type DivisionDiscipline = "KYORUGI" | "POOMSAE" | "UNSTATED";

export interface DivisionCandidate extends CalendarCandidate {
  // competition_source.raw_divisions de l'entrée calendrier WT, tel que stocké
  // (non typé : validé ici, toute forme inattendue ⇒ candidate indécidable).
  divisions: unknown;
}

// Catégorie de poids : "-54kg", "+87kg", "K44 -58kg"... Le Poomsae n'en a pas.
const WEIGHT_CATEGORY = /[-+]\d+(\.\d+)?\s*kg\b/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function resultsDisciplineFromCategories(categoryLabels: string[]): ResultsDiscipline {
  if (categoryLabels.length === 0) return "UNKNOWN";
  return categoryLabels.every((label) => WEIGHT_CATEGORY.test(label)) ? "KYORUGI" : "UNKNOWN";
}

// Seul le premier segment écrit par la source compte ("Kyorugi / Senior").
export function divisionDiscipline(label: string | null): DivisionDiscipline {
  const first = (label ?? "").split("/")[0].trim().toLowerCase();
  if (first === "kyorugi") return "KYORUGI";
  if (first === "poomsae") return "POOMSAE";
  return "UNSTATED";
}

interface ParsedDivision {
  kind: DivisionDiscipline;
  start: string | null;
  end: string | null;
}

type DivisionCompatibility = "COMPATIBLE" | "INCOMPATIBLE" | "UNKNOWN";

export function mapResultsCompetitionByDivisions(
  results: WtrCompetitionRef,
  candidates: DivisionCandidate[],
  otherResultsCompetitions: WtrCompetitionRef[],
  resultsDiscipline: ResultsDiscipline,
): WtrMappingResult {
  const normalizedName = normalizeCompetitionName(results.name);
  const tokens = distinctiveTokens(results.name);
  const unmatched = (reasons: string[]): WtrMappingResult => ({ normalizedName, verdict: "UNMATCHED", competitionId: null, reasons });

  if (tokens.length < MIN_DISTINCTIVE_TOKENS) {
    return unmatched([`nom Results trop générique après normalisation ("${normalizedName}")`]);
  }
  if (resultsDiscipline !== "KYORUGI") {
    return unmatched(["discipline Kyorugi du Results non prouvée par ses catégories"]);
  }

  const start = isoDay(results.dateStart);
  const end = isoDay(results.dateEnd);
  const assessed: { candidate: DivisionCandidate; status: DivisionCompatibility; why: string }[] = [];
  for (const candidate of candidates) {
    if (!sameTokenSet(tokens, distinctiveTokens(candidate.nom))) continue;
    if (!rangeContains(candidate, start, end)) continue;
    assessed.push({ candidate, ...divisionCompatibility(candidate.divisions, start, end) });
  }
  const describe = (a: (typeof assessed)[number]) => `${a.candidate.competitionId} ("${a.candidate.nom}") ${a.status}: ${a.why}`;

  const compatible = assessed.filter((a) => a.status === "COMPATIBLE");
  const undecidable = assessed.filter((a) => a.status === "UNKNOWN");
  if (compatible.length === 0) {
    return unmatched([
      "aucune candidate homonyme dont la plage contient le Results et dont les divisions prouvent le Kyorugi",
      ...assessed.map(describe),
    ]);
  }
  if (compatible.length > 1 || undecidable.length > 0) {
    return {
      normalizedName,
      verdict: "AMBIGUOUS",
      competitionId: null,
      reasons: ["plusieurs candidates homonymes ne peuvent pas être départagées par les divisions", ...assessed.map(describe)],
    };
  }

  const target = compatible[0].candidate;
  const rivals = otherResultsCompetitions.filter(
    (other) =>
      other.slug !== results.slug &&
      sameTokenSet(tokens, distinctiveTokens(other.name)) &&
      rangeContains(target, isoDay(other.dateStart), isoDay(other.dateEnd)),
  );
  if (rivals.length > 0) {
    return {
      normalizedName,
      verdict: "AMBIGUOUS",
      competitionId: null,
      reasons: [`une autre compétition Results homonyme tombe dans la plage de la candidate: ${rivals.map((r) => r.slug).join(", ")}`],
    };
  }

  return {
    normalizedName,
    verdict: "SAFE",
    competitionId: target.competitionId,
    reasons: [
      `plage Results ${start}..${end} contenue dans la plage calendrier`,
      compatible[0].why,
      `ensemble de mots distinctifs identique: ${tokens.join(", ")}`,
      "une seule candidate, aucun concurrent Results",
    ],
  };
}

function divisionCompatibility(raw: unknown, start: string, end: string): { status: DivisionCompatibility; why: string } {
  const divisions = parseDivisions(raw);
  if (!divisions) return { status: "UNKNOWN", why: "divisions calendrier absentes ou illisibles" };

  const missing: string[] = [];
  for (let day = start; day <= end; day = nextDay(day)) {
    if (!divisions.some((d) => d.kind === "KYORUGI" && covers(d, day))) missing.push(day);
  }
  if (missing.length === 0) return { status: "COMPATIBLE", why: "chaque jour Results couvert par une division Kyorugi" };

  // Un jour sans Kyorugi explicite reste indécidable s'il pourrait relever d'une
  // division sans discipline déclarée (datée sur ce jour, ou non datée).
  const unstatedMayCover = missing.some((day) => divisions.some((d) => d.kind === "UNSTATED" && covers(d, day)));
  const undatedNonPoomsae = divisions.some((d) => d.start === null && d.kind !== "POOMSAE");
  if (unstatedMayCover || undatedNonPoomsae) {
    return { status: "UNKNOWN", why: `jour(s) ${missing.join(", ")} couverts seulement par une division sans discipline déclarée` };
  }
  return { status: "INCOMPATIBLE", why: `jour(s) ${missing.join(", ")} sans division Kyorugi (Poomsae seul ou rien de programmé)` };
}

// null si la forme n'est pas exactement celle écrite par l'importeur calendrier.
function parseDivisions(raw: unknown): ParsedDivision[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const parsed: ParsedDivision[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const { dateText, discipline, start, end } = item as Record<string, unknown>;
    if (typeof dateText !== "string") return null;
    if (discipline !== null && typeof discipline !== "string") return null;
    const undated = start === null && end === null;
    const dated = typeof start === "string" && typeof end === "string" && ISO_DAY.test(start) && ISO_DAY.test(end) && start <= end;
    if (!undated && !dated) return null;
    parsed.push({ kind: divisionDiscipline(discipline), start: dated ? start : null, end: dated ? end : null });
  }
  return parsed;
}

function covers(division: ParsedDivision, day: string): boolean {
  return division.start !== null && division.end !== null && division.start <= day && day <= division.end;
}

function rangeContains(candidate: CalendarCandidate, start: string, end: string): boolean {
  return isoDay(candidate.dateDebut) <= start && end <= isoDay(candidate.dateFin ?? candidate.dateDebut);
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function distinctiveTokens(name: string): string[] {
  const normalized = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const tokens = normalized
    .split(" ")
    .filter((t) => t.length > 0 && !GENERIC_TOKENS.has(t))
    .filter((t) => !YEAR_TOKEN.test(t))
    .filter((t) => !ORDINAL_TOKEN.test(t));
  return [...new Set(tokens)].sort();
}

function sameTokenSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((token, i) => token === b[i]);
}

function sameDay(a: Date, b: Date): boolean {
  return isoDay(a) === isoDay(b);
}
