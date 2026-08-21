import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class WeightsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async athleteExists(athleteId: string): Promise<boolean> {
    const athlete = await this.prisma.athlete.findUnique({
      where: { id: athleteId },
      select: { id: true },
    });
    return athlete !== null;
  }

  createWeightLog(athleteId: string, data: { weight: number; measuredAt: Date; note?: string }) {
    return this.prisma.weight_log.create({
      data: {
        athlete_id: athleteId,
        valeur_kg: data.weight,
        date_mesure: data.measuredAt,
        note: data.note,
      },
    });
  }

  findWeightLogsByAthlete(athleteId: string) {
    return this.prisma.weight_log.findMany({
      where: { athlete_id: athleteId },
      orderBy: { date_mesure: "desc" },
    });
  }

  findLatestWeightLog(athleteId: string) {
    return this.prisma.weight_log.findFirst({
      where: { athlete_id: athleteId },
      orderBy: { date_mesure: "desc" },
    });
  }

  // La dernière mesure disponible datant d'au moins 7 jours par rapport à `cutoff`
  // (cutoff = date de la mesure actuelle - 7 jours). Voir WeightsService pour le
  // détail de l'algorithme de calcul de weeklyChange.
  findReferenceWeightLog(athleteId: string, cutoff: Date) {
    return this.prisma.weight_log.findFirst({
      where: { athlete_id: athleteId, date_mesure: { lte: cutoff } },
      orderBy: { date_mesure: "desc" },
    });
  }

  findActiveWeightTarget(athleteId: string) {
    return this.prisma.weight_target.findFirst({
      where: { athlete_id: athleteId, actif: true },
      orderBy: { created_at: "desc" },
    });
  }

  // Un seul objectif actif à la fois : désactive l'ancien (sans le supprimer) puis
  // crée le nouveau dans la même transaction, pour ne jamais laisser l'athlète
  // temporairement sans objectif actif ni avec deux objectifs actifs simultanés.
  replaceActiveWeightTarget(
    athleteId: string,
    data: { weight: number; targetDate?: Date; competitionId?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.weight_target.updateMany({
        where: { athlete_id: athleteId, actif: true },
        data: { actif: false },
      });

      return tx.weight_target.create({
        data: {
          athlete_id: athleteId,
          competition_id: data.competitionId,
          poids_cible_kg: data.weight,
          date_cible: data.targetDate,
        },
      });
    });
  }
}
