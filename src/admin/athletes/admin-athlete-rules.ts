import { MANUAL_SOURCE } from "../competitions/admin-competition-origin";

// Règles des athlètes internationaux saisis dans EkvaraAdmin (external_athlete
// — JAMAIS un compte EKVARA app_user/athlete).

export type AthleteOrigin = "manual" | "imported";
export type AthleteField = "displayName" | "countryCode" | "gender" | "birthDate";

// Même règle que les compétitions : "manual" uniquement si toutes les
// sources sont des saisies manuelles ; toute source d'import (WT Results...)
// rend l'athlète "importé".
export function athleteOrigin(sources: { source: string }[]): AthleteOrigin {
  return sources.length > 0 && sources.every((s) => s.source === MANUAL_SOURCE) ? "manual" : "imported";
}

// Athlète importé : nom et code pays restent ceux de la source (l'import WT
// les écrit). gender/birth_date ne sont jamais fournis ni lus par aucun
// importeur (vérifié : WtResultsImportService / InternationalRepository) :
// les renseigner enrichit le profil sans jamais modifier une donnée WT.
export const EDITABLE_ATHLETE_FIELDS: Record<AthleteOrigin, readonly AthleteField[]> = {
  manual: ["displayName", "countryCode", "gender", "birthDate"],
  imported: ["gender", "birthDate"],
};

// Convention existante (competition_entry.gender, normaliseur Martial Events).
export const GENDERS = ["male", "female"] as const;
export type Gender = (typeof GENDERS)[number];

// Jetons de nom normalisés : casse, accents et ponctuation ignorés, ordre des
// mots ignoré ("KIM Minsu" = "Minsu Kim" — WT publie souvent NOM Prénom).
export function nameTokens(name: string): string[] {
  const tokens = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0);
  return [...new Set(tokens)].sort();
}

export type AthleteDuplicateLevel = "probable" | "possible";

export interface ExistingAthlete {
  id: string;
  display_name: string;
  country_code: string | null;
  birth_date: Date | null;
  sources: { source: string }[];
}

export interface AthleteDuplicateCandidate {
  id: string;
  displayName: string;
  countryCode: string | null;
  birthDate: string | null;
  sources: string[];
  level: AthleteDuplicateLevel;
  reasons: string[];
}

// Détection purement informative (jamais de fusion) :
// - même nom (jetons identiques) -> "probable", sauf pays ou date de
//   naissance CONNUS des deux côtés et différents -> "possible" (homonyme
//   plausible, à vérifier) ;
// - nom inclus dans l'autre (au moins 2 mots en commun, ex. deuxième
//   prénom) -> "possible".
// Un nom seul ne suffit jamais à affirmer qu'il s'agit de la même personne :
// l'administrateur confirme toujours explicitement.
export function detectDuplicateAthletes(
  input: { displayName: string; countryCode: string | null; birthDate: Date | null },
  existing: ExistingAthlete[],
): AthleteDuplicateCandidate[] {
  const mine = nameTokens(input.displayName);
  const candidates: AthleteDuplicateCandidate[] = [];

  for (const athlete of existing) {
    const theirs = nameTokens(athlete.display_name);
    const sameName = mine.length > 0 && mine.join(" ") === theirs.join(" ");
    const [shorter, longer] = mine.length <= theirs.length ? [mine, theirs] : [theirs, mine];
    const contained = !sameName && shorter.length >= 2 && shorter.every((t) => longer.includes(t));
    if (!sameName && !contained) continue;

    const reasons = [sameName ? "nom identique (ordre des mots, casse et accents ignorés)" : "nom proche (un nom contient l'autre)"];
    let conflict = false;
    if (input.countryCode && athlete.country_code) {
      if (input.countryCode === athlete.country_code) reasons.push(`même pays (${athlete.country_code})`);
      else {
        reasons.push(`pays différent (${input.countryCode} / ${athlete.country_code})`);
        conflict = true;
      }
    }
    if (input.birthDate && athlete.birth_date) {
      if (input.birthDate.getTime() === athlete.birth_date.getTime()) reasons.push("même date de naissance");
      else {
        reasons.push("date de naissance différente");
        conflict = true;
      }
    }

    candidates.push({
      id: athlete.id,
      displayName: athlete.display_name,
      countryCode: athlete.country_code,
      birthDate: athlete.birth_date ? athlete.birth_date.toISOString().slice(0, 10) : null,
      sources: [...new Set(athlete.sources.map((s) => s.source))],
      level: sameName && !conflict ? "probable" : "possible",
      reasons,
    });
  }

  return candidates.sort((a, b) => (a.level === b.level ? a.displayName.localeCompare(b.displayName) : a.level === "probable" ? -1 : 1));
}
