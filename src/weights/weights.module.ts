import { Module } from "@nestjs/common";
import { CompetitionsModule } from "../competitions/competitions.module";
import { AuthGuardsModule } from "../auth/auth-guards.module";
import { WeightsController } from "./weights.controller";
import { WeightsService } from "./weights.service";
import { WeightsRepository } from "./weights.repository";

@Module({
  imports: [CompetitionsModule, AuthGuardsModule],
  controllers: [WeightsController],
  providers: [WeightsService, WeightsRepository],
  // WeightsService.createWeightTarget/getWeightSummary sont réutilisés tels
  // quels par CoachAthleteWeightsController (voir ticket "Pilotage individuel
  // Coach") : mêmes méthodes, même comportement, jamais un CoachWeightsService
  // parallèle qui copierait cette logique.
  exports: [WeightsService],
})
export class WeightsModule {}
