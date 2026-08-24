import { Module } from "@nestjs/common";
import { AuthGuardsModule } from "../auth/auth-guards.module";
import { GoalsController } from "./goals.controller";
import { GoalsService } from "./goals.service";
import { GoalsRepository } from "./goals.repository";

@Module({
  imports: [AuthGuardsModule],
  controllers: [GoalsController],
  providers: [GoalsService, GoalsRepository],
  // GoalsService (createGoal/findAllForAthlete/addStep/updateStep/
  // updateStatus) est réutilisé tel quel par CoachAthleteGoalsController
  // (voir ticket "Pilotage individuel Coach") : mêmes méthodes, y compris
  // assertGoalBelongsToAthlete/stepBelongsToGoal internes, jamais recodées
  // côté coach.
  exports: [GoalsService],
})
export class GoalsModule {}
