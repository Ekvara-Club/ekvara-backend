import { Module } from "@nestjs/common";
import { AuthGuardsModule } from "../auth/auth-guards.module";
import { TrainingsController } from "./trainings.controller";
import { TrainingsService } from "./trainings.service";
import { TrainingsRepository } from "./trainings.repository";

@Module({
  imports: [AuthGuardsModule],
  controllers: [TrainingsController],
  providers: [TrainingsService, TrainingsRepository],
})
export class TrainingsModule {}
