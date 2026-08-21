import { Injectable, NotFoundException } from "@nestjs/common";
import { competition_entry as CompetitionEntryModel } from "../../generated/prisma/client";
import { CompetitionsRepository } from "./competitions.repository";
import { CompetitionEntriesRepository } from "./competition-entries.repository";

@Injectable()
export class CompetitionEntriesService {
  constructor(
    private readonly competitionsRepository: CompetitionsRepository,
    private readonly competitionEntriesRepository: CompetitionEntriesRepository,
  ) {}

  async findByCompetition(competitionId: string) {
    const competition = await this.competitionsRepository.findById(competitionId);
    if (!competition) {
      throw new NotFoundException(`Competition ${competitionId} introuvable`);
    }

    const entries = await this.competitionEntriesRepository.findByCompetition(competitionId);
    return toEntriesView(competitionId, entries);
  }
}

// Vue stable, jamais l'objet Prisma brut : pas de created_at/updated_at, pas
// de competition_id/source répétés sur chaque entry (déjà connus au niveau
// racine de la réponse). Regroupée par catégorie source (source_category_
// raw_label = la clé la plus fidèle à la donnée réelle, jamais reconstruite
// à partir d'ageCategory/gender/weightCategory qui peuvent être null).
function toEntriesView(competitionId: string, entries: CompetitionEntryModel[]) {
  const byRawLabel = new Map<string, CompetitionEntryModel[]>();
  for (const entry of entries) {
    const bucket = byRawLabel.get(entry.source_category_raw_label);
    if (bucket) {
      bucket.push(entry);
    } else {
      byRawLabel.set(entry.source_category_raw_label, [entry]);
    }
  }

  const categories = [...byRawLabel.values()]
    .map((group) => {
      const [{ source_category_raw_label, age_category, gender, weight_category }] = group;
      return {
        rawLabel: source_category_raw_label,
        ageCategory: age_category,
        gender,
        weightCategory: weight_category,
        entries: [...group]
          .sort((a, b) => a.participant_name.localeCompare(b.participant_name))
          .map((e) => ({
            id: e.id,
            name: e.participant_name,
            club: e.club,
            league: e.league,
            country: e.country,
          })),
      };
    })
    .sort(compareCategories);

  return {
    competitionId,
    categories,
    totalEntries: entries.length,
  };
}

// Tri déterministe et volontairement simple (voir ticket) : jamais de
// ranking numérique de poids ("-100 kg" vs "-58 kg" ne se compare pas
// correctement en tant que chaînes) — ageCategory puis gender puis
// weightCategory en ASC texte, rawLabel en filet de sécurité final pour une
// stabilité totale même si les trois premiers champs sont tous null.
function compareCategories(
  a: { ageCategory: string | null; gender: string | null; weightCategory: string | null; rawLabel: string },
  b: { ageCategory: string | null; gender: string | null; weightCategory: string | null; rawLabel: string },
): number {
  return (
    compareNullable(a.ageCategory, b.ageCategory) ||
    compareNullable(a.gender, b.gender) ||
    compareNullable(a.weightCategory, b.weightCategory) ||
    a.rawLabel.localeCompare(b.rawLabel)
  );
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}
