import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { AthletesModule } from "./athletes/athletes.module";
import { CompetitionsModule } from "./competitions/competitions.module";
import { ParticipationsModule } from "./participations/participations.module";
import { WeightsModule } from "./weights/weights.module";
import { GoalsModule } from "./goals/goals.module";
import { MetricsModule } from "./metrics/metrics.module";
import { TrainingsModule } from "./trainings/trainings.module";
import { AuthModule } from "./auth/auth.module";
import { ExercisesModule } from "./exercises/exercises.module";
import { CoachModule } from "./coach/coach.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { InternationalModule } from "./international/international.module";
import { HealthModule } from "./health/health.module";

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    AthletesModule,
    CompetitionsModule,
    ParticipationsModule,
    WeightsModule,
    GoalsModule,
    MetricsModule,
    TrainingsModule,
    ExercisesModule,
    NotificationsModule,
    CoachModule,
    InternationalModule,
    HealthModule,
  ],
})
export class AppModule {}
