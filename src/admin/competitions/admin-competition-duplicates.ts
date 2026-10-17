import { matchCompetitions } from "../../competitions/matching/competition-matcher";
import { ImportedCompetition } from "../../competitions/importers/imported-competition.interface";

// Détection de doublons AVANT une saisie manuelle — purement informative :
// ne fusionne jamais, ne rattache jamais, ne bloque que tant que
// l'administrateur n'a pas explicitement confirmé chaque correspondance.
//
// Réutilise la règle existante matchCompetitions() (celle des importeurs),
// sans la modifier :
// - même date de début : verdict de la règle tel quel (SAFE -> "probable",
//   AMBIGUOUS -> "possible") ;
// - date de début proche (± WINDOW_DAYS) : la règle exige une date
//   identique, donc les signaux de nom/ville sont évalués en neutralisant la
//   date ; toute correspondance devient au mieux "possible" — une saisie
//   manuelle avec une date erronée d'un jour ne doit pas passer inaperçue.
export const DUPLICATE_WINDOW_DAYS = 7;

export type DuplicateLevel = "probable" | "possible";

export interface ExistingCompetition {
  id: string;
  nom: string;
  date_debut: Date;
  date_fin: Date | null;
  lieu: string | null;
  ville: string | null;
  pays: string | null;
  organisateur: string | null;
  niveau: string | null;
  sources: { source: string }[];
}

export interface DuplicateInput {
  nom: string;
  dateDebut: Date;
  dateFin: Date | null;
  lieu: string | null;
  ville: string | null;
  pays: string | null;
  organisateur: string | null;
  niveau: string | null;
}

export interface DuplicateCandidate {
  id: string;
  nom: string;
  dateDebut: string;
  dateFin: string | null;
  ville: string | null;
  pays: string | null;
  sources: string[];
  level: DuplicateLevel;
  dayGap: number;
  // Strictement identique (nom, dates de début et de fin, ville, pays) :
  // création refusée, aucune confirmation possible.
  exact: boolean;
  reasons: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SAME_DATE_REASON = "date de début identique";

export function detectDuplicateCompetitions(input: DuplicateInput, existing: ExistingCompetition[]): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = [];

  for (const competition of existing) {
    const dayGap = Math.round((competition.date_debut.getTime() - input.dateDebut.getTime()) / DAY_MS);
    if (Math.abs(dayGap) > DUPLICATE_WINDOW_DAYS) continue;

    // Date neutralisée : seule la comparaison nom/ville de la règle compte ici.
    const verdict = matchCompetitions(toImported(competition), { ...toImportedInput(input), dateDebut: competition.date_debut });
    const sameName = normalizeName(competition.nom) === normalizeName(input.nom);
    if (verdict.confidence === "DIFFERENT" && !sameName) continue;

    const reasons = verdict.reasons.filter((r) => r !== SAME_DATE_REASON);
    if (sameName) reasons.unshift("nom identique");
    reasons.unshift(dayGap === 0 ? SAME_DATE_REASON : `date de début à ${Math.abs(dayGap)} jour(s) d'écart`);

    const level: DuplicateLevel = dayGap === 0 && (verdict.confidence === "SAFE" || sameName) ? "probable" : "possible";
    // Identité stricte : tous les champs qui définissent la compétition
    // coïncident (null = null). Un nom identique avec une autre ville, un
    // autre pays ou d'autres dates reste une correspondance à confirmer.
    const exact =
      sameName &&
      dayGap === 0 &&
      sameDay(competition.date_fin, input.dateFin) &&
      sameText(competition.ville, input.ville) &&
      sameText(competition.pays, input.pays);
    if (exact) reasons.push("compétition strictement identique (nom, dates, ville, pays) : création impossible");
    candidates.push({
      id: competition.id,
      nom: competition.nom,
      dateDebut: isoDay(competition.date_debut),
      dateFin: competition.date_fin ? isoDay(competition.date_fin) : null,
      ville: competition.ville,
      pays: competition.pays,
      sources: competition.sources.map((s) => s.source),
      level,
      dayGap,
      exact,
      reasons,
    });
  }

  return candidates.sort((a, b) => levelRank(a.level) - levelRank(b.level) || Math.abs(a.dayGap) - Math.abs(b.dayGap));
}

function levelRank(level: DuplicateLevel): number {
  return level === "probable" ? 0 : 1;
}

function normalizeName(nom: string): string {
  return nom
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sameDay(a: Date | null, b: Date | null): boolean {
  return a === null || b === null ? a === b : a.getTime() === b.getTime();
}

function sameText(a: string | null, b: string | null): boolean {
  return normalizeName(a ?? "") === normalizeName(b ?? "");
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// matchCompetitions() ne lit jamais source/sourceExternalId : valeurs neutres.
function toImported(c: ExistingCompetition): ImportedCompetition {
  return {
    source: "__canonical__",
    sourceExternalId: c.id,
    nom: c.nom,
    dateDebut: c.date_debut,
    dateFin: c.date_fin ?? undefined,
    lieu: c.lieu ?? undefined,
    ville: c.ville ?? undefined,
    pays: c.pays ?? undefined,
    organisateur: c.organisateur ?? undefined,
    niveau: c.niveau ?? undefined,
  };
}

function toImportedInput(input: DuplicateInput): ImportedCompetition {
  return {
    source: "__admin_input__",
    sourceExternalId: "__admin_input__",
    nom: input.nom,
    dateDebut: input.dateDebut,
    dateFin: input.dateFin ?? undefined,
    lieu: input.lieu ?? undefined,
    ville: input.ville ?? undefined,
    pays: input.pays ?? undefined,
    organisateur: input.organisateur ?? undefined,
    niveau: input.niveau ?? undefined,
  };
}
