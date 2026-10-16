import { Injectable } from "@nestjs/common";
import { Prisma } from "../../../generated/prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { MANUAL_SOURCE } from "../competitions/admin-competition-origin";
import { athleteOrigin, ExistingAthlete } from "./admin-athlete-rules";

// Écritures du portail admin sur external_athlete / external_athlete_source.
// N'appelle JAMAIS InternationalRepository.upsertAthleteFromSource (chemin de
// l'import WT), ne touche jamais une source d'import, ni app_user, athlete ou
// athlete_wt_link (comptes EKVARA).

export interface AthleteData {
  display_name: string;
  country_code: string | null;
  gender: string | null;
  birth_date: Date | null;
}

export class AthleteNoLongerManualError extends Error {}

const LIST_SELECT = {
  id: true,
  display_name: true,
  country_code: true,
  gender: true,
  birth_date: true,
  sources: { select: { source: true }, orderBy: { created_at: "asc" as const } },
  _count: { select: { matches_as_a: true, matches_as_b: true } },
} satisfies Prisma.external_athleteSelect;

export type AthleteListRow = Prisma.external_athleteGetPayload<{ select: typeof LIST_SELECT }>;

const CANDIDATE_LIMIT = 200;

@Injectable()
export class AdminAthletesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: { search?: string; country?: string; page: number; limit: number; origin: "all" | "manual" | "imported" }) {
    const and: Prisma.external_athleteWhereInput[] = [];
    if (params.search) and.push({ display_name: { contains: params.search, mode: "insensitive" } });
    if (params.country) and.push({ country_code: params.country });
    if (params.origin === "manual") {
      and.push({ sources: { some: { source: MANUAL_SOURCE }, every: { source: MANUAL_SOURCE } } });
    } else if (params.origin === "imported") {
      and.push({ OR: [{ sources: { some: { source: { not: MANUAL_SOURCE } } } }, { sources: { none: {} } }] });
    }
    const where: Prisma.external_athleteWhereInput = and.length > 0 ? { AND: and } : {};

    const [rows, total] = await Promise.all([
      this.prisma.external_athlete.findMany({
        where,
        select: LIST_SELECT,
        orderBy: [{ display_name: "asc" }, { id: "asc" }],
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      this.prisma.external_athlete.count({ where }),
    ]);
    return { rows, total };
  }

  // Codes pays réellement présents (filtre de la liste) — jamais une liste
  // codée en dur.
  async listCountries(): Promise<string[]> {
    const rows = await this.prisma.external_athlete.groupBy({
      by: ["country_code"],
      where: { country_code: { not: null } },
      orderBy: { country_code: "asc" },
    });
    return rows.map((r) => r.country_code!).filter(Boolean);
  }

  // Candidats d'un doublon : athlètes dont le nom contient l'un des mots
  // significatifs du nom saisi (pré-filtre SQL ; la décision est prise par
  // detectDuplicateAthletes). Limite : la comparaison SQL est sensible aux
  // accents — un nom n'est manqué que si AUCUN de ses mots n'apparaît tel quel.
  findDuplicateCandidates(tokens: string[], excludeId?: string): Promise<ExistingAthlete[]> {
    const significant = tokens.filter((t) => t.length >= 3);
    const words = significant.length > 0 ? significant : tokens;
    if (words.length === 0) return Promise.resolve([]);
    return this.prisma.external_athlete.findMany({
      where: {
        OR: words.map((word) => ({ display_name: { contains: word, mode: "insensitive" as const } })),
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true, display_name: true, country_code: true, gender: true, birth_date: true, sources: { select: { source: true } } },
      orderBy: [{ display_name: "asc" }, { id: "asc" }],
      take: CANDIDATE_LIMIT,
    });
  }

  // Athlète + provenance manuelle en UNE transaction. source_external_id =
  // external_athlete.id : identifiant interne stable, unique par
  // construction, sans collision possible avec un identifiant WT.
  async createManual(data: AthleteData) {
    return this.prisma.$transaction(async (tx) => {
      const athlete = await tx.external_athlete.create({ data });
      await tx.external_athlete_source.create({
        data: {
          external_athlete_id: athlete.id,
          source: MANUAL_SOURCE,
          source_external_id: athlete.id,
          source_url: null,
          raw_name: data.display_name,
        },
      });
      return athlete;
    });
  }

  // Origine revérifiée DANS la transaction (une source d'import ne peut pas
  // être rattachée entre-temps sans que la modification soit refusée).
  async updateManual(id: string, data: AthleteData) {
    return this.prisma.$transaction(async (tx) => {
      const sources = await tx.external_athlete_source.findMany({ where: { external_athlete_id: id }, select: { source: true } });
      if (athleteOrigin(sources) !== "manual") throw new AthleteNoLongerManualError();
      await tx.external_athlete.update({ where: { id }, data: { ...data, updated_at: new Date() } });
      await tx.external_athlete_source.updateMany({
        where: { external_athlete_id: id, source: MANUAL_SOURCE },
        data: { raw_name: data.display_name, updated_at: new Date() },
      });
    });
  }

  // Athlète importé : SEULS genre et date de naissance sont écrits — jamais
  // le nom, le code pays ni une ligne external_athlete_source WT.
  async updateEnrichment(id: string, data: Pick<AthleteData, "gender" | "birth_date">) {
    await this.prisma.external_athlete.update({ where: { id }, data: { gender: data.gender, birth_date: data.birth_date, updated_at: new Date() } });
  }

  countConfirmedAccountLinks(id: string): Promise<number> {
    return this.prisma.athlete_wt_link.count({ where: { external_athlete_id: id, status: "confirmed" } });
  }
}
