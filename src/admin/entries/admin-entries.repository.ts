import { Injectable } from "@nestjs/common";
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
}

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

  listByCompetition(competitionId: string) {
    return this.prisma.competition_entry.findMany({
      where: { competition_id: competitionId },
      orderBy: [{ source_category_raw_label: "asc" }, { participant_name: "asc" }, { id: "asc" }],
    });
  }

  findById(id: string) {
    return this.prisma.competition_entry.findUnique({ where: { id } });
  }

  // Tous les inscrits de la compétition (toutes sources) : base de la
  // détection de doublons, faite en mémoire (volume borné par compétition).
  findForDuplicates(competitionId: string, excludeId?: string) {
    return this.prisma.competition_entry.findMany({
      where: { competition_id: competitionId, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true, participant_name: true, source_category_raw_label: true, club: true, country: true, source: true },
    });
  }

  create(competitionId: string, data: EntryData) {
    return this.prisma.competition_entry.create({ data: { competition_id: competitionId, source: MANUAL_SOURCE, ...data } });
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
