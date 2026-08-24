import { Module } from "@nestjs/common";
import { AuthGuardsModule } from "../auth/auth-guards.module";
import { MetricsController } from "./metrics.controller";
import { MetricsService } from "./metrics.service";
import { MetricsRepository } from "./metrics.repository";

@Module({
  imports: [AuthGuardsModule],
  controllers: [MetricsController],
  providers: [MetricsService, MetricsRepository],
  // MetricsRepository.findAllMetricTypes() est réutilisé tel quel par
  // CoachDashboardRepository (batch) : catalogue des metric_type, sans
  // dépendance à un athlète, aucune raison de le requêter deux fois.
  // MetricsService (createMeasurement/findMeasurements/getOverview) est
  // réutilisé tel quel par CoachAthleteMetricsController (voir ticket
  // "Évaluations / Métriques Coach") : mêmes méthodes, aucun service coach
  // parallèle.
  exports: [MetricsRepository, MetricsService],
})
export class MetricsModule {}
