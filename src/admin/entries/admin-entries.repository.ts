import { Injectable } from "@nestjs/common";
import type { Prisma } from "../../../generated/prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { MANUAL_SOURCE } from "../competitions/admin-competition-origin";

export interface EntryData {
  participant_name: string;
  source_category_raw_label: string;
  age_category: string | null;
  gender: string | null;
  weight_category: string | null;
  club: string | null;
  country: string | null;
  external_athlete_id: string | null;
}

// Fiche athlète liée (identité affichée seulement).
const ENTRY_INCLUDE = { external_athlete: { select: { id: true, display_name: true, country_code: true } } } as const;
export type EntryRecord = Prisma.competition_entryGetPayload<{ include: typeof ENTRY_INCLUDE }>;

// Écritures du portail sur competition_entry : uniquement des lignes
// source = ekvara_manual. La synchronisation Martial Events
// (CompetitionEntriesRepository.syncForCompetition) est cloisonnée par
// (compétition, source) et ne lit, ne modifie ni ne supprime jamais ces
// lignes ; réciproquement, rien ici ne touche une ligne importée.
@Injectable()
export class AdminEntriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  competitionExists(competitionId: string): Promise<number> {
    return this.prisma.competition.count({ where: { id: competitionId } });
  }

  listByCompetition(competitionId: string): Promise<EntryRecord[]> {
    return this.prisma.competition_entry.findMany({
      where: { competition_id: competitionId },
      orderBy: [{ source_category_raw_label: "asc" }, { participant_name: "asc" }, { id: "asc" }],
      include: ENTRY_INCLUDE,
    });
  }

  findById(id: string): Promise<EntryRecord | null> {
    return this.prisma.competition_entry.findUnique({ where: { id }, include: ENTRY_INCLUDE });
  }

  // Tous les inscrits de la compétition (toutes sources) : base de la
  // détection de doublons, faite en mémoire (volume borné par compétition).
  findForDuplicates(competitionId: string, excludeId?: string) {
    return this.prisma.competition_entry.findMany({
      where: { competition_id: competitionId, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: {
        id: true,
        participant_name: true,
        source_category_raw_label: true,
        club: true,
        country: true,
        source: true,
        external_athlete_id: true,
      },
    });
  }

  // Fiches athlètes existantes parmi ids (lien participant -> fiche).
  async existingAthleteIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.external_athlete.findMany({ where: { id: { in: ids } }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  }

  create(competitionId: string, data: EntryData): Promise<EntryRecord> {
    return this.prisma.competition_entry.create({ data: { competition_id: competitionId, source: MANUAL_SOURCE, ...data }, include: ENTRY_INCLUDE });
  }

  // Lot : une seule transaction, tout ou rien (une contrainte unique violée
  // par n'importe quelle ligne annule toutes les lignes du lot).
  createMany(competitionId: string, rows: EntryData[]) {
    return this.prisma.$transaction(
      async (tx) => {
        const created: EntryRecord[] = [];
        for (const data of rows) {
          created.push(
            await tx.competition_entry.create({ data: { competition_id: competitionId, source: MANUAL_SOURCE, ...data }, include: ENTRY_INCLUDE }),
          );
        }
        return created;
      },
      { timeout: 20_000 },
    );
  }

  // Seule la colonne du lien est écrite : les données du participant (y
  // compris importées) restent intactes. Une resynchronisation Martial
  // Events, qui recrée ses lignes, fait perdre le lien d'un inscrit importé.
  setAthlete(id: string, externalAthleteId: string): Promise<EntryRecord> {
    return this.prisma.competition_entry.update({ where: { id }, data: { external_athlete_id: externalAthleteId }, include: ENTRY_INCLUDE });
  }

  // La condition source = ekvara_manual fait partie de l'écriture elle-même :
  // une ligne importée ne peut jamais être modifiée, même en concurrence.
  async updateManual(id: string, data: EntryData): Promise<boolean> {
    const result = await this.prisma.competition_entry.updateMany({
      where: { id, source: MANUAL_SOURCE },
      data: { ...data, updated_at: new Date() },
    });
    return result.count === 1;
  }
}
