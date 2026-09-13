import { Module } from "@nestjs/common";
import { AuthGuardsModule } from "../auth/auth-guards.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";
import { NotificationsRepository } from "./notifications.repository";

@Module({
  imports: [AuthGuardsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsRepository],
  // NotificationsRepository exporté pour que CoachTrainingsRepository et
  // CoachExercisesRepository puissent insérer des notifications DANS leur
  // propre transaction Prisma existante (voir ticket "TRANSACTIONS") sans
  // dépendre de NotificationsService — répository-à-répository, même
  // précédent que WeightsService qui dépend directement de
  // CompetitionsRepository. NotificationsService exporté pour les mutations
  // non transactionnelles (goals, weight-targets).
  exports: [NotificationsService, NotificationsRepository],
})
export class NotificationsModule {}
