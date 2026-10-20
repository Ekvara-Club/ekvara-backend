import { nameTokens } from "../athletes/admin-athlete-rules";
import { MANUAL_SOURCE } from "../competitions/admin-competition-origin";

// Participants (competition_entry) saisis dans EkvaraAdmin. Un participant
// est une INSCRIPTION à une compétition : jamais un compte EKVARA. Il n'est
// relié à une fiche external_athlete que si l'administrateur l'a choisie
// explicitement dans la base (external_athlete_id) — jamais par le nom.

export type EntryOrigin = "manual" | "imported";

// Une ligne competition_entry n'a qu'UNE source (colonne source). Les
// inscrits importés (Martial Events : synchronisation miroir par
// (compétition, source)) restent en lecture seule.
export function entryOrigin(source: string): EntryOrigin {
  return source === MANUAL_SOURCE ? "manual" : "imported";
}

export interface ExistingEntry {
  id: string;
  participant_name: string;
  source_category_raw_label: string;
  club: string | null;
  country: string | null;
  source: string;
  external_athlete_id?: string | null;
}

export interface EntryDuplicateCandidate {
  id: string;
  participantName: string;
  category: string;
  club: string | null;
  country: string | null;
  source: string;
  level: "probable" | "possible";
  reasons: string[];
}

export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Même nom (ordre des mots, casse, accents ignorés) dans la même catégorie
// -> "probable" ; dans une autre catégorie, ou nom inclus dans l'autre ->
// "possible" (un athlète peut légitimement être inscrit dans deux
// catégories). Jamais de fusion : signalement seulement.
export function detectDuplicateEntries(
  input: { participantName: string; category: string },
  existing: ExistingEntry[],
): EntryDuplicateCandidate[] {
  const mine = nameTokens(input.participantName);
  const category = normalizeLabel(input.category);
  const candidates: EntryDuplicateCandidate[] = [];

  for (const entry of existing) {
    const theirs = nameTokens(entry.participant_name);
    const sameName = mine.length > 0 && mine.join(" ") === theirs.join(" ");
    const [shorter, longer] = mine.length <= theirs.length ? [mine, theirs] : [theirs, mine];
    const contained = !sameName && shorter.length >= 2 && shorter.every((t) => longer.includes(t));
    if (!sameName && !contained) continue;

    const sameCategory = normalizeLabel(entry.source_category_raw_label) === category;
    candidates.push({
      id: entry.id,
      participantName: entry.participant_name,
      category: entry.source_category_raw_label,
      club: entry.club,
      country: entry.country,
      source: entry.source,
      level: sameName && sameCategory ? "probable" : "possible",
      reasons: [
        sameName ? "nom identique (ordre des mots, casse et accents ignorés)" : "nom proche (un nom contient l'autre)",
        sameCategory ? "même catégorie" : `autre catégorie (${entry.source_category_raw_label})`,
      ],
    });
  }
  return candidates.sort((a, b) => (a.level === b.level ? a.participantName.localeCompare(b.participantName) : a.level === "probable" ? -1 : 1));
}
