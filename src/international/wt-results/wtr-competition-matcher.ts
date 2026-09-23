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
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}
