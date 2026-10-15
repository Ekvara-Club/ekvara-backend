import { Controller, Get, Injectable, UseGuards } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AdminGuard } from "./admin.guard";
import { competitionOrigin } from "./competitions/admin-competition-origin";

const RECENT_LIMIT = 5;

// Tableau de bord (ticket §7) : chiffres lus en base à chaque appel, jamais
// codés en dur. "Sans résultats" = aucun competition_match (combat logique)
// rattaché ; "passées" = fin effective (date_fin ?? date_debut) avant
// aujourd'hui, même règle que le catalogue (next-competition.ts).
//
// Toutes les lectures dans UNE transaction REPEATABLE READ : un seul
// instantané cohérent. Sans elle, une compétition créée entre deux comptages
// (synchro, saisie) pouvait afficher plus de "sans résultats" que de
// compétitions.
@Injectable()
export class AdminStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async getStats() {
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const pastWhere = { OR: [{ date_fin: { lt: today } }, { date_fin: null, date_debut: { lt: today } }] };

    const [competitions, athletes, matches, withoutResults, pastWithoutResults, recentCompetitions, recentAthletes, recentMatches] =
      await this.prisma.$transaction(
        [
        this.prisma.competition.count(),
        this.prisma.external_athlete.count(),
        this.prisma.competition_match.count(),
        this.prisma.competition.count({ where: { matches: { none: {} } } }),
        this.prisma.competition.count({ where: { matches: { none: {} }, ...pastWhere } }),
        this.prisma.competition.findMany({
          orderBy: [{ created_at: "desc" }, { id: "asc" }],
          take: RECENT_LIMIT,
          select: { id: true, nom: true, date_debut: true, created_at: true, sources: { select: { source: true } } },
        }),
        this.prisma.external_athlete.findMany({
          orderBy: [{ created_at: "desc" }, { id: "asc" }],
          take: RECENT_LIMIT,
          select: { id: true, display_name: true, country_code: true, created_at: true },
        }),
        this.prisma.competition_match.findMany({
          orderBy: [{ created_at: "desc" }, { id: "asc" }],
          take: RECENT_LIMIT,
          select: {
            id: true,
            created_at: true,
            category_label: true,
            competition: { select: { id: true, nom: true } },
            athlete_a: { select: { display_name: true } },
            athlete_b: { select: { display_name: true } },
          },
        }),
        ],
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );

    return {
      totals: { competitions, athletes, matches, competitionsWithoutResults: withoutResults, pastCompetitionsWithoutResults: pastWithoutResults },
      recent: {
        competitions: recentCompetitions.map((c) => ({
          id: c.id,
          nom: c.nom,
          dateDebut: c.date_debut.toISOString().slice(0, 10),
          origin: competitionOrigin(c.sources),
          createdAt: c.created_at?.toISOString() ?? null,
        })),
        athletes: recentAthletes.map((a) => ({
          id: a.id,
          displayName: a.display_name,
          countryCode: a.country_code,
          createdAt: a.created_at?.toISOString() ?? null,
        })),
        matches: recentMatches.map((m) => ({
          id: m.id,
          competitionId: m.competition.id,
          competitionNom: m.competition.nom,
          categoryLabel: m.category_label,
          athleteA: m.athlete_a.display_name,
          athleteB: m.athlete_b.display_name,
          createdAt: m.created_at?.toISOString() ?? null,
        })),
      },
    };
  }
}

@Controller("admin/stats")
@UseGuards(AdminGuard)
export class AdminStatsController {
  constructor(private readonly stats: AdminStatsService) {}

  @Get()
  get() {
    return this.stats.getStats();
  }
}
