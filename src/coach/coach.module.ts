import { Module } from "@nestjs/common";
import { AuthGuardsModule } from "../auth/auth-guards.module";
import { AthletesModule } from "../athletes/athletes.module";
import { MetricsModule } from "../metrics/metrics.module";
import { WeightsModule } from "../weights/weights.module";
import { GoalsModule } from "../goals/goals.module";
import { CoachController } from "./coach.controller";
import { CoachService } from "./coach.service";
import { CoachRepository } from "./coach.repository";
import { CoachGroupsController } from "./coach-groups.controller";
import { CoachGroupsService } from "./coach-groups.service";
import { CoachGroupsRepository } from "./coach-groups.repository";
import { CoachDashboardController } from "./coach-dashboard.controller";
import { CoachDashboardService } from "./coach-dashboard.service";
import { CoachDashboardRepository } from "./coach-dashboard.repository";
import { CoachTrainingsController } from "./coach-trainings.controller";
import { CoachTrainingsService } from "./coach-trainings.service";
import { CoachTrainingsRepository } from "./coach-trainings.repository";
import { CoachDestinataireResolver } from "./coach-destinataire-resolver";
import { CoachExercisesController } from "./coach-exercises.controller";
import { CoachExercisesService } from "./coach-exercises.service";
import { CoachExercisesRepository } from "./coach-exercises.repository";
import { CoachAthleteWeightsController } from "./coach-athlete-weights.controller";
import { CoachAthleteGoalsController } from "./coach-athlete-goals.controller";
import { CoachAthleteMetricsController } from "./coach-athlete-metrics.controller";
import { CoachCompetitionsController } from "./coach-competitions.controller";
import { CoachCompetitionsService } from "./coach-competitions.service";
import { CoachCompetitionsRepository } from "./coach-competitions.repository";
import { CoachCompetitionPreparationsController } from "./coach-competition-preparations.controller";
import { CoachCompetitionPreparationsService } from "./coach-competition-preparations.service";
import { CoachCompetitionPreparationsRepository } from "./coach-competition-preparations.repository";
import { CoachTrainingAttendanceController } from "./coach-training-attendance.controller";
import { CoachAthleteAttendanceController } from "./coach-athlete-attendance.controller";
import { CoachTrainingAttendanceService } from "./coach-training-attendance.service";
import { CoachTrainingAttendanceRepository } from "./coach-training-attendance.repository";

@Module({
  // AthletesModule : réutilise AthletesService.findOne() pour GET
  // /coach/athletes/:athleteId (voir ticket #1) plutôt que de dupliquer la
  // logique de lecture d'un athlète. MetricsModule : réutilise
  // MetricsRepository.findAllMetricTypes() (ticket #2) et MetricsService
  // (ticket #6) tels quels. WeightsModule/GoalsModule : réutilisent
  // WeightsService/GoalsService tels quels pour le pilotage individuel coach
  // (voir ticket #5) — aucun service coach parallèle.
  imports: [AuthGuardsModule, AthletesModule, MetricsModule, WeightsModule, GoalsModule],
  controllers: [
    CoachController,
    CoachGroupsController,
    CoachDashboardController,
    CoachTrainingsController,
    CoachExercisesController,
    CoachAthleteWeightsController,
    CoachAthleteGoalsController,
    CoachAthleteMetricsController,
    CoachCompetitionsController,
    CoachCompetitionPreparationsController,
    CoachTrainingAttendanceController,
    CoachAthleteAttendanceController,
  ],
  providers: [
    CoachService,
    CoachRepository,
    CoachGroupsService,
    CoachGroupsRepository,
    CoachDashboardService,
    CoachDashboardRepository,
    CoachTrainingsService,
    CoachTrainingsRepository,
    CoachDestinataireResolver,
    CoachExercisesService,
    CoachExercisesRepository,
    CoachCompetitionsService,
    CoachCompetitionsRepository,
    CoachCompetitionPreparationsService,
    CoachCompetitionPreparationsRepository,
    CoachTrainingAttendanceService,
    CoachTrainingAttendanceRepository,
  ],
})
export class CoachModule {}
