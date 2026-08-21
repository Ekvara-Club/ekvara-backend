import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { metric_measurement, metric_type } from "../../generated/prisma/client";

@Injectable()
export class MetricsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async athleteExists(athleteId: string): Promise<boolean> {
    const athlete = await this.prisma.athlete.findUnique({
      where: { id: athleteId },
      select: { id: true },
    });
    return athlete !== null;
  }

  async appUserExists(userId: string): Promise<boolean> {
    const user = await this.prisma.app_user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    return user !== null;
  }

  async metricTypeExists(metricTypeId: string): Promise<boolean> {
    const metricType = await this.prisma.metric_type.findUnique({
      where: { id: metricTypeId },
      select: { id: true },
    });
    return metricType !== null;
  }

  findAllMetricTypes(): Promise<metric_type[]> {
    return this.prisma.metric_type.findMany({ orderBy: { code: "asc" } });
  }

  createMeasurement(
    athleteId: string,
    metricTypeId: string,
    data: { value: number; measuredAt: Date; coachUserId?: string; comment?: string },
  ): Promise<metric_measurement> {
    return this.prisma.metric_measurement.create({
      data: {
        athlete_id: athleteId,
        metric_type_id: metricTypeId,
        valeur: data.value,
        mesure_le: data.measuredAt,
        coach_user_id: data.coachUserId,
        commentaire: data.comment,
      },
    });
  }

  findMeasurementsByAthleteAndMetric(
    athleteId: string,
    metricTypeId: string,
  ): Promise<metric_measurement[]> {
    return this.prisma.metric_measurement.findMany({
      where: { athlete_id: athleteId, metric_type_id: metricTypeId },
      orderBy: { mesure_le: "desc" },
    });
  }

  // Les deux dernières mesures (par mesure_le, date métier du test — pas
  // created_at) pour une métrique donnée d'un athlète. [0] = actuelle,
  // [1] = précédente. L'un ou l'autre est null s'il n'y a pas assez d'historique.
  async findLastTwoMeasurements(
    athleteId: string,
    metricTypeId: string,
  ): Promise<readonly [metric_measurement | null, metric_measurement | null]> {
    const rows = await this.prisma.metric_measurement.findMany({
      where: { athlete_id: athleteId, metric_type_id: metricTypeId },
      orderBy: { mesure_le: "desc" },
      take: 2,
    });
    return [rows[0] ?? null, rows[1] ?? null] as const;
  }
}
