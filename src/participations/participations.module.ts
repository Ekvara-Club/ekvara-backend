import { Module } from "@nestjs/common";
import { CompetitionsModule } from "../competitions/competitions.module";
import { AuthGuardsModule } from "../auth/auth-guards.module";
import { ParticipationsController } from "./participations.controller";
import { ParticipationsService } from "./participations.service";
import { ParticipationsRepository } from "./participations.repository";

@Module({
  imports: [CompetitionsModule, AuthGuardsModule],
  controllers: [ParticipationsController],
  providers: [ParticipationsService, ParticipationsRepository],
})
export class ParticipationsModule {}
