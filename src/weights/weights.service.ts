import { Injectable, NotFoundException } from "@nestjs/common";
import { CompetitionsRepository } from "../competitions/competitions.repository";
import { CreateWeightLogDto } from "./dto/create-weight-log.dto";
import { CreateWeightTargetDto } from "./dto/create-weight-target.dto";
import { WeightsRepository } from "./weights.repository";

// Exportée pour que CoachDashboardService puisse calculer `weeklyChange` en
// batch (fenêtre "il y a une semaine" par athlète depuis un historique déjà
// chargé en mémoire) avec exactement le même seuil que getWeightSummary,
// jamais une valeur redupliquée en dur.
export const REFERENCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class WeightsService {
  constructor(
    private readonly weightsRepository: WeightsRepository,
    private readonly competitionsRepository: CompetitionsRepository,
  ) {}

  async createWeightLog(athleteId: string, dto: CreateWeightLogDto) {
    await this.assertAthleteExists(athleteId);

    const created = await this.weightsRepository.createWeightLog(athleteId, {
      weight: dto.weight,
      measuredAt: dto.measuredAt ? new Date(dto.measuredAt) : new Date(),
      note: dto.note,
    });

    return toWeightLogView(created);
  }

  async findWeightLogsForAthlete(athleteId: string) {
    await this.assertAthleteExists(athleteId);

    const logs = await this.weightsRepository.findWeightLogsByAthlete(athleteId);
    return logs.map(toWeightLogView);
  }

  async createWeightTarget(athleteId: string, dto: CreateWeightTargetDto) {
    await this.assertAthleteExists(athleteId);

    if (dto.competitionId) {
      const competition = await this.competitionsRepository.findById(dto.competitionId);
      if (!competition) {
        throw new NotFoundException(`Competition ${dto.competitionId} introuvable`);
      }
    }

    const created = await this.weightsRepository.replaceActiveWeightTarget(athleteId, {
      weight: dto.weight,
      targetDate: dto.targetDate ? new Date(dto.targetDate) : undefined,
      competitionId: dto.competitionId,
    });

    return toWeightTargetView(created);
  }

  // Algorithme "weeklyChange" (tendance récente simple, MVP) :
  //   1. currentLog = la mesure la plus récente de l'athlète.
  //      Si aucune mesure -> currentWeight, measuredAt et weeklyChange sont null.
  //   2. cutoff = currentLog.date_mesure - 7 jours (exactement 7*24h en millisecondes,
  //      pas un simple arrondi calendaire).
  //   3. referenceLog = la mesure la plus récente dont date_mesure <= cutoff, s'il en
  //      existe une (c'est la mesure la plus proche d'"il y a une semaine", sans
  //      jamais être plus récente que 7 jours avant la mesure actuelle).
  //      Si aucune mesure ne remonte à au moins 7 jours -> weeklyChange = null.
  //   4. weeklyChange = round2(currentWeight - referenceWeight).
  // differenceToTarget = round2(currentWeight - target.weight), signe conservé.
  async getWeightSummary(athleteId: string) {
    await this.assertAthleteExists(athleteId);

    const [latestLog, activeTarget] = await Promise.all([
      this.weightsRepository.findLatestWeightLog(athleteId),
      this.weightsRepository.findActiveWeightTarget(athleteId),
    ]);

    const currentWeight = latestLog ? latestLog.valeur_kg.toNumber() : null;
    const measuredAt = latestLog ? latestLog.date_mesure : null;

    const target = activeTarget
      ? {
          weight: activeTarget.poids_cible_kg.toNumber(),
          targetDate: activeTarget.date_cible,
          competitionId: activeTarget.competition_id,
        }
      : null;

    let referenceWeight: number | null = null;
    if (latestLog) {
      const cutoff = new Date(latestLog.date_mesure.getTime() - REFERENCE_WINDOW_MS);
      const referenceLog = await this.weightsRepository.findReferenceWeightLog(athleteId, cutoff);
      referenceWeight = referenceLog ? referenceLog.valeur_kg.toNumber() : null;
    }

    return computeWeightSummary(currentWeight, measuredAt, target, referenceWeight);
  }

  private async assertAthleteExists(athleteId: string): Promise<void> {
    const exists = await this.weightsRepository.athleteExists(athleteId);
    if (!exists) {
      throw new NotFoundException(`Athlete ${athleteId} introuvable`);
    }
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface WeightTargetView {
  weight: number;
  targetDate: Date | null;
  competitionId: string | null;
}

export interface WeightSummaryView {
  currentWeight: number | null;
  measuredAt: Date | null;
  target: WeightTargetView | null;
  differenceToTarget: number | null;
  weeklyChange: number | null;
}

// Logique pure, sans dépendance Prisma/Nest (même principe que
// MetricsService.compareMeasurements) : différence à l'objectif et variation
// hebdomadaire à partir de valeurs déjà résolues. Seule source de vérité de
// cette formule — réutilisée telle quelle par CoachDashboardService pour ne
// jamais recalculer differenceToTarget/weeklyChange différemment en batch.
export function computeWeightSummary(
  currentWeight: number | null,
  measuredAt: Date | null,
  target: WeightTargetView | null,
  referenceWeight: number | null,
): WeightSummaryView {
  const differenceToTarget =
    currentWeight !== null && target !== null ? round2(currentWeight - target.weight) : null;
  const weeklyChange =
    currentWeight !== null && referenceWeight !== null ? round2(currentWeight - referenceWeight) : null;

  return { currentWeight, measuredAt, target, differenceToTarget, weeklyChange };
}

function toWeightLogView(log: { id: string; valeur_kg: { toNumber(): number }; date_mesure: Date; note: string | null }) {
  return {
    id: log.id,
    weight: log.valeur_kg.toNumber(),
    measuredAt: log.date_mesure,
    note: log.note,
  };
}

function toWeightTargetView(target: {
  id: string;
  poids_cible_kg: { toNumber(): number };
  date_cible: Date | null;
  competition_id: string | null;
  actif: boolean | null;
}) {
  return {
    id: target.id,
    weight: target.poids_cible_kg.toNumber(),
    targetDate: target.date_cible,
    competitionId: target.competition_id,
    actif: target.actif,
  };
}
