import { Injectable } from "@nestjs/common";
import { Prisma } from "../../../generated/prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { DUPLICATE_WINDOW_DAYS, ExistingCompetition } from "./admin-competition-duplicates";
import { competitionOrigin, MANUAL_SOURCE } from "./admin-competition-origin";

// Écritures du portail admin sur competition / competition_source. N'appelle
// JAMAIS CompetitionsRepository.upsertFromSource (chemin des importeurs) et
// ne touche jamais une competition_source d'import.

export interface CompetitionData {
  nom: string;
  organisateur: string | null;
  date_debut: Date;
  date_fin: Date | null;
  lieu: string | null;
  ville: string | null;
  pays: string | null;
  niveau: string | null;
  saison: string | null;
}

export class CompetitionNoLongerManualError extends Error {}

const LIST_SELECT = {
  id: true,
  nom: true,
  date_debut: true,
  date_fin: true,
  ville: true,
  pays: true,
  niveau: true,
  saison: true,
  created_at: true,
  sources: { select: { source: true }, orderBy: { created_at: "asc" as const } },
  _count: { select: { matches: true, entries: true } },
} satisfies Prisma.competitionSelect;

export type CompetitionListRow = Prisma.competitionGetPayload<{ select: typeof LIST_SELECT }>;

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AdminCompetitionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Mêmes critères de recherche/année que CompetitionsRepository
  // .findManyPaginated (nom/ville/pays insensibles à la casse, année de
  // date_debut), plus ce dont l'administration a besoin et que l'endpoint
  // public n'expose pas : nombre de combats, tri dans les deux sens, origine.
  async list(params: { search?: string; year?: number; page: number; limit: number; sort: "asc" | "desc"; origin: "all" | "manual" | "imported" }) {
    const and: Prisma.competitionWhereInput[] = [];
    if (params.search) {
      and.push({
        OR: [
          { nom: { contains: params.search, mode: "insensitive" } },
          { ville: { contains: params.search, mode: "insensitive" } },
          { pays: { contains: params.search, mode: "insensitive" } },
        ],
      });
    }
    if (params.year !== undefined) {
      and.push({ date_debut: { gte: new Date(Date.UTC(params.year, 0, 1)), lt: new Date(Date.UTC(params.year + 1, 0, 1)) } });
    }
    if (params.origin === "manual") {
      and.push({ sources: { some: { source: MANUAL_SOURCE }, every: { source: MANUAL_SOURCE } } });
    } else if (params.origin === "imported") {
      and.push({ OR: [{ sources: { some: { source: { not: MANUAL_SOURCE } } } }, { sources: { none: {} } }] });
    }
    const where: Prisma.competitionWhereInput = and.length > 0 ? { AND: and } : {};

    const [rows, total] = await Promise.all([
      this.prisma.competition.findMany({
        where,
        orderBy: [{ date_debut: params.sort }, { id: "asc" }],
        skip: (params.page - 1) * params.limit,
        take: params.limit,
        select: LIST_SELECT,
      }),
      this.prisma.competition.count({ where }),
    ]);
    return { rows, total };
  }

  // Compétitions dont la date de début est à ± DUPLICATE_WINDOW_DAYS : seules
  // candidates possibles d'un doublon (voir admin-competition-duplicates.ts).
  findDuplicateCandidates(dateDebut: Date, excludeId?: string): Promise<ExistingCompetition[]> {
    return this.prisma.competition.findMany({
      where: {
        date_debut: {
          gte: new Date(dateDebut.getTime() - DUPLICATE_WINDOW_DAYS * DAY_MS),
          lte: new Date(dateDebut.getTime() + DUPLICATE_WINDOW_DAYS * DAY_MS),
        },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: {
        id: true,
        nom: true,
        date_debut: true,
        date_fin: true,
        lieu: true,
        ville: true,
        pays: true,
        organisateur: true,
        niveau: true,
        sources: { select: { source: true }, orderBy: { created_at: "asc" } },
      },
      orderBy: [{ date_debut: "asc" }, { id: "asc" }],
      take: 100,
    });
  }

  // competition + sa provenance manuelle dans UNE transaction : jamais une
  // compétition sans source, jamais une source orpheline.
  // source_external_id = competition.id : identifiant interne stable, unique
  // par construction, sans collision possible avec un identifiant d'import.
  async createManual(data: CompetitionData) {
    return this.prisma.$transaction(async (tx) => {
      const competition = await tx.competition.create({ data });
      await tx.competition_source.create({
        data: {
          competition_id: competition.id,
          source: MANUAL_SOURCE,
          source_external_id: competition.id,
          match_confidence: null,
          ...rawManualPayload(data),
        },
      });
      return competition;
    });
  }

  // Origine revérifiée DANS la transaction : si une source d'import a été
  // rattachée entre la lecture et l'écriture (synchro concurrente), rien
  // n'est modifié.
  async updateManual(id: string, data: CompetitionData) {
    return this.prisma.$transaction(async (tx) => {
      const sources = await tx.competition_source.findMany({ where: { competition_id: id }, select: { source: true } });
      if (competitionOrigin(sources) !== "manual") {
        throw new CompetitionNoLongerManualError();
      }
      await tx.competition.update({ where: { id }, data: { ...data, updated_at: new Date() } });
      await tx.competition_source.updateMany({
        where: { competition_id: id, source: MANUAL_SOURCE },
        data: { ...rawManualPayload(data), updated_at: new Date() },
      });
    });
  }

  // Compétition importée : SEUL le champ saison est écrit (décision D4).
  async updateSaison(id: string, saison: string | null) {
    await this.prisma.competition.update({ where: { id }, data: { saison, updated_at: new Date() } });
  }
}

// Valeurs brutes de CETTE source (comme rawSourcePayload des importeurs) :
// pour une saisie manuelle, ce que l'administrateur a saisi.
function rawManualPayload(data: CompetitionData) {
  return {
    raw_nom: data.nom,
    raw_organisateur: data.organisateur,
    raw_lieu: data.lieu,
    raw_ville: data.ville,
    raw_pays: data.pays,
    raw_niveau: data.niveau,
  };
}
