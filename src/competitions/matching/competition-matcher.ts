import { ImportedCompetition } from "../importers/imported-competition.interface";

// Prototype PUR de matching entre deux compétitions importées de sources
// différentes (voir ticket "Audit et conception de la déduplication
// multi-sources"). Aucun accès réseau ni DB ici : ne décide jamais seul de
// fusionner quoi que ce soit, se contente de classer une paire dans l'un de
// trois niveaux de confiance explicables.
//
// IMPORTANT (contrainte explicite du ticket) : aucun signal pris seul n'est
// jamais suffisant pour un niveau "SAFE". En particulier, une même ville
// seule ne vaut jamais une fusion automatique (cas réel identifié :
// "Open Labellisé de Poissy" (FFTDA, 2026-02-07/08) et "International
// Training Camp Poissy 2026" (Martial Events, 2026-10-28/31) partagent la
// même ville mais sont deux événements réellement différents).

export type MatchConfidence = "SAFE" | "AMBIGUOUS" | "DIFFERENT";

export interface MatchResult {
  confidence: MatchConfidence;
  reasons: string[];
}

// Abréviations fédérales réellement observées dans le calendrier FFTDA
// (https://www.fftda.fr/files/collection/53/fr.json, audité pour ce ticket et
// le précédent) — jamais une liste inventée : uniquement des formes
// rencontrées dans les données réelles, et uniquement celles nécessaires à
// faire converger un nom FFTDA abrégé vers le nom complet équivalent utilisé
// par Martial Events.
const FEDERATION_ABBREVIATIONS: Record<string, string> = {
  chpt: "championnat",
  cpe: "coupe",
  fra: "france",
};

// Mots trop génériques pour constituer un signal de correspondance à eux
// seuls (connecteurs français/anglais usuels). Les années sont exclues
// séparément : la date de début est déjà comparée explicitement plus haut
// dans l'algorithme, un même millésime ne doit pas être recompté comme un
// signal de nom.
const STOPWORDS = new Set([
  "de", "du", "des", "le", "la", "les", "et", "d", "l", "au", "aux", "en", "a",
  "the", "of", "and", "combat", "poomsae",
]);

// Catégories d'âge officielles FFTDA (voir aussi me-normalizer.ts pour la
// même liste côté catégories d'inscrits) : reconnues par préfixe pour
// absorber singulier/pluriel ("senior"/"seniors", "cadet"/"cadette"...) sans
// dictionnaire de formes fléchies.
const AGE_CATEGORY_TOKENS = [
  "poussin", "benjamin", "minime", "cadet", "junior", "espoir", "senior", "master",
];

export function matchCompetitions(a: ImportedCompetition, b: ImportedCompetition): MatchResult {
  if (!sameDateDebut(a.dateDebut, b.dateDebut)) {
    return { confidence: "DIFFERENT", reasons: ["dates de début différentes"] };
  }

  const tokensA = significantTokens(a.nom);
  const tokensB = significantTokens(b.nom);

  const sharedAgeTokens = intersect(extractAgeTokens(tokensA), extractAgeTokens(tokensB));
  const nationalMarkerBoth = hasNationalMarker(tokensA) && hasNationalMarker(tokensB);

  // IMPORTANT (constaté réellement en intégration Postgres, pas seulement en
  // théorie) : le marqueur national ("championnat"/"coupe" + "france") SEUL
  // n'est PAS un signal suffisant pour un SAFE. Deux compétitions
  // nationales FFTDA différentes (ex. "Championnat de France Poomsae" et un
  // "Championnat de France Seniors (Combat)") peuvent être programmées le
  // même jour et partager ce marqueur sans être la même compétition. Seule
  // une catégorie d'âge explicitement partagée est un signal assez fort pour
  // fusionner automatiquement ; le marqueur national ne fait alors que
  // corroborer un signal déjà présent, jamais le déclencher seul.
  if (sharedAgeTokens.size > 0) {
    const reasons = ["date de début identique", `catégorie(s) d'âge partagée(s) dans le nom: ${[...sharedAgeTokens].join(", ")}`];
    if (nationalMarkerBoth) {
      reasons.push("marqueur national (championnat/coupe + france) présent des deux côtés");
    }
    return { confidence: "SAFE", reasons };
  }

  const sharedTokens = intersect(tokensA, tokensB);
  const villeMatch = !!a.ville && !!b.ville && normalizeText(a.ville) === normalizeText(b.ville);

  if (sharedTokens.size > 0 || villeMatch || nationalMarkerBoth) {
    const reasons = ["date de début identique"];
    if (sharedTokens.size > 0) {
      reasons.push(`mot(s) significatif(s) partagé(s) dans le nom: ${[...sharedTokens].join(", ")}`);
    }
    if (villeMatch) {
      reasons.push(`même ville (${a.ville}) — jamais suffisant seul pour un SAFE`);
    }
    if (nationalMarkerBoth) {
      reasons.push("marqueur national (championnat/coupe + france) présent des deux côtés — jamais suffisant seul pour un SAFE");
    }
    reasons.push("signal insuffisant pour une fusion automatique : revue manuelle requise");
    return { confidence: "AMBIGUOUS", reasons };
  }

  return {
    confidence: "DIFFERENT",
    reasons: ["même date de début mais aucun signal de nom ou de lieu commun"],
  };
}

function sameDateDebut(a: Date, b: Date): boolean {
  return isoDay(a) === isoDay(b);
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function significantTokens(nom: string): Set<string> {
  const words = normalizeText(nom).split(" ").filter(Boolean);
  const expanded = words.map((w) => FEDERATION_ABBREVIATIONS[w] ?? w);
  return new Set(
    expanded.filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d{4}$/.test(w)),
  );
}

function extractAgeTokens(tokens: Set<string>): Set<string> {
  const found = new Set<string>();
  for (const token of tokens) {
    const age = AGE_CATEGORY_TOKENS.find((a) => token.startsWith(a));
    if (age) found.add(age);
  }
  return found;
}

function hasNationalMarker(tokens: Set<string>): boolean {
  return tokens.has("france") && (tokens.has("championnat") || tokens.has("coupe"));
}

function intersect<T>(a: Set<T>, b: Set<T>): Set<T> {
  return new Set([...a].filter((x) => b.has(x)));
}
