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
})
export class WeightsModule {}
