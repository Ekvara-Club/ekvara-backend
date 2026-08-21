import { Injectable, NotFoundException } from "@nestjs/common";
import { metric_measurement, metric_type } from "../../generated/prisma/client";
import { ImprovementDirection, isImprovementDirection } from "./improvement-direction";
import { CreateMeasurementDto } from "./dto/create-measurement.dto";
import { MetricsRepository } from "./metrics.repository";

export type ComparisonStatus = "improved" | "stable" | "regressed" | "unknown";

const MAX_HIGHLIGHTS = 3;

export interface Highlight {
  metricTypeId: string;
  code: string;
  name: string;
  unit: string | null;
  direction: ImprovementDirection;
  previousValue: number;
  currentValue: number;
  delta: number;
  percentage: number | null;
  status: "improved";
  previousMeasuredAt: Date;
  currentMeasuredAt: Date;
}

export interface MetricOverviewEntry {
  id: string;
  code: string;
  name: string;
  unit: string | null;
  direction: string | null;
  currentValue: number | null;
  previousValue: number | null;
  delta: number | null;
  percentage: number | null;
  status: ComparisonStatus;
  measuredAt: Date | null;
}

export interface MetricsOverviewResponse {
  metrics: MetricOverviewEntry[];
}

// Résultat intermédiaire partagé par /progress/highlights et /metrics/overview :
// les deux endpoints comparent chaque metric_type aux deux dernières mesures de
// l'athlète, seule la mise en forme finale diffère (highlights filtre sur
// "improved" uniquement, overview renvoie tout).
interface MetricComparison {
  metricType: metric_type;
  currentMeasurement: metric_measurement | null;
  previousMeasurement: metric_measurement | null;
  status: ComparisonStatus;
  currentValue: number | null;
  previousValue: number | null;
  delta: number | null;
  percentage: number | null;
}

// Logique pure, sans dépendance Prisma/Nest : comparaison de deux mesures
// d'une même métrique.
//   - improvement_direction null (ou toute valeur hors "higher"/"lower") -> "unknown" :
//     la métrique ne doit jamais être interprétée automatiquement.
//   - valeurs égales -> "stable", jamais confondu avec "unknown".
export function compareMeasurements(
  direction: string | null,
  current: number,
  previous: number,
): ComparisonStatus {
  if (!isImprovementDirection(direction)) return "unknown";
  if (current === previous) return "stable";
  if (direction === "higher") return current > previous ? "improved" : "regressed";
  return current < previous ? "improved" : "regressed";
}

// Pourcentage d'évolution, positif = amélioration, négatif = régression, quel
// que soit le sens brut de la variation. `previous === 0` -> null (division
// par zéro mathématiquement indéfinie, jamais tentée).
export function computePercentage(
  direction: ImprovementDirection,
  current: number,
  previous: number,
): number | null {
  if (previous === 0) return null;
  const raw =
    direction === "higher"
      ? ((current - previous) / previous) * 100
      : ((previous - current) / previous) * 100;
  return round2(raw);
}

@Injectable()
export class MetricsService {
  constructor(private readonly metricsRepository: MetricsRepository) {}

  async createMeasurement(athleteId: string, metricTypeId: string, dto: CreateMeasurementDto) {
    await this.assertAthleteExists(athleteId);
    await this.assertMetricTypeExists(metricTypeId);

    if (dto.coachUserId) {
      const coachExists = await this.metricsRepository.appUserExists(dto.coachUserId);
      if (!coachExists) {
        throw new NotFoundException(`Utilisateur ${dto.coachUserId} introuvable`);
      }
    }

    const created = await this.metricsRepository.createMeasurement(athleteId, metricTypeId, {
      value: dto.value,
      measuredAt: dto.measuredAt ? new Date(dto.measuredAt) : new Date(),
      coachUserId: dto.coachUserId,
      comment: dto.comment,
    });

    return toMeasurementView(created);
  }

  async findMeasurements(athleteId: string, metricTypeId: string) {
    await this.assertAthleteExists(athleteId);
    await this.assertMetricTypeExists(metricTypeId);

    const measurements = await this.metricsRepository.findMeasurementsByAthleteAndMetric(
      athleteId,
      metricTypeId,
    );
    return measurements.map(toMeasurementView);
  }

  async getHighlights(athleteId: string) {
    await this.assertAthleteExists(athleteId);

    const comparisons = await this.compareAllMetricTypes(athleteId);

    const improved = comparisons
      .filter((comparison) => comparison.status === "improved")
      .map(toHighlight);
    const sorted = [...improved].sort(byPercentageDesc);

    return {
      improvedCount: improved.length,
      highlights: sorted.slice(0, MAX_HIGHLIGHTS),
    };
  }

  // Contrairement à /progress/highlights (qui ne garde que les améliorations),
  // /metrics/overview renvoie systématiquement tous les metric_type connus,
  // y compris ceux sans aucune mesure pour cet athlète : le Passeport doit
  // pouvoir montrer toutes les capacités connues, évaluées ou non.
  async getOverview(athleteId: string): Promise<MetricsOverviewResponse> {
    await this.assertAthleteExists(athleteId);

    const comparisons = await this.compareAllMetricTypes(athleteId);

    return { metrics: comparisons.map(toOverviewEntry) };
  }

  private async compareAllMetricTypes(athleteId: string): Promise<MetricComparison[]> {
    const metricTypes = await this.metricsRepository.findAllMetricTypes();
    return Promise.all(metricTypes.map((metricType) => this.compareMetricType(athleteId, metricType)));
  }

  private async compareMetricType(athleteId: string, metricType: metric_type): Promise<MetricComparison> {
    const [currentMeasurement, previousMeasurement] = await this.metricsRepository.findLastTwoMeasurements(
      athleteId,
      metricType.id,
    );

    if (!currentMeasurement) {
      return {
        metricType,
        currentMeasurement: null,
        previousMeasurement: null,
        status: "unknown",
        currentValue: null,
        previousValue: null,
        delta: null,
        percentage: null,
      };
    }

    const current = currentMeasurement.valeur.toNumber();

    if (!previousMeasurement) {
      return {
        metricType,
        currentMeasurement,
        previousMeasurement: null,
        status: "unknown",
        currentValue: current,
        previousValue: null,
        delta: null,
        percentage: null,
      };
    }

    const previous = previousMeasurement.valeur.toNumber();
    const status = compareMeasurements(metricType.improvement_direction, current, previous);

    // "unknown" ici signifie improvement_direction invalide : les deux valeurs
    // réelles restent affichables, mais aucune interprétation (delta/pourcentage)
    // ne doit être avancée sans direction fiable pour la calculer.
    if (status === "unknown") {
      return {
        metricType,
        currentMeasurement,
        previousMeasurement,
        status,
        currentValue: current,
        previousValue: previous,
        delta: null,
        percentage: null,
      };
    }

    // status "improved"/"regressed"/"stable" ne peut survenir que si
    // compareMeasurements a validé improvement_direction comme "higher" ou "lower".
    const direction = metricType.improvement_direction as ImprovementDirection;

    return {
      metricType,
      currentMeasurement,
      previousMeasurement,
      status,
      currentValue: current,
      previousValue: previous,
      delta: round2(current - previous),
      percentage: computePercentage(direction, current, previous),
    };
  }

  private async assertAthleteExists(athleteId: string): Promise<void> {
    const exists = await this.metricsRepository.athleteExists(athleteId);
    if (!exists) {
      throw new NotFoundException(`Athlete ${athleteId} introuvable`);
    }
  }

  private async assertMetricTypeExists(metricTypeId: string): Promise<void> {
    const exists = await this.metricsRepository.metricTypeExists(metricTypeId);
    if (!exists) {
      throw new NotFoundException(`Metric type ${metricTypeId} introuvable`);
    }
  }
}

// N'est appelée que pour des comparaisons déjà filtrées sur status === "improved" :
// currentMeasurement/previousMeasurement/currentValue/previousValue/delta sont
// alors garantis non-null par compareMetricType (seule la branche finale, avec
// les deux mesures et une direction valide, peut produire ce statut).
function toHighlight(comparison: MetricComparison): Highlight {
  return {
    metricTypeId: comparison.metricType.id,
    code: comparison.metricType.code,
    name: comparison.metricType.nom,
    unit: comparison.metricType.unite,
    direction: comparison.metricType.improvement_direction as ImprovementDirection,
    previousValue: comparison.previousValue as number,
    currentValue: comparison.currentValue as number,
    delta: comparison.delta as number,
    percentage: comparison.percentage,
    status: "improved",
    previousMeasuredAt: comparison.previousMeasurement!.mesure_le,
    currentMeasuredAt: comparison.currentMeasurement!.mesure_le,
  };
}

function toOverviewEntry(comparison: MetricComparison): MetricOverviewEntry {
  return {
    id: comparison.metricType.id,
    code: comparison.metricType.code,
    name: comparison.metricType.nom,
    unit: comparison.metricType.unite,
    direction: comparison.metricType.improvement_direction,
    currentValue: comparison.currentValue,
    previousValue: comparison.previousValue,
    delta: comparison.delta,
    percentage: comparison.percentage,
    status: comparison.status,
    measuredAt: comparison.currentMeasurement?.mesure_le ?? null,
  };
}

function byPercentageDesc(a: Highlight, b: Highlight): number {
  if (a.percentage === null && b.percentage === null) return 0;
  if (a.percentage === null) return 1;
  if (b.percentage === null) return -1;
  return b.percentage - a.percentage;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toMeasurementView(measurement: metric_measurement) {
  return {
    id: measurement.id,
    value: measurement.valeur.toNumber(),
    measuredAt: measurement.mesure_le,
    coachUserId: measurement.coach_user_id,
    comment: measurement.commentaire,
  };
}
