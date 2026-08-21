import { Module } from "@nestjs/common";
import { AuthGuardsModule } from "../auth/auth-guards.module";
import { ExercisesController } from "./exercises.controller";
import { ExercisesService } from "./exercises.service";
import { ExercisesRepository } from "./exercises.repository";

@Module({
  imports: [AuthGuardsModule],
  controllers: [ExercisesController],
  providers: [ExercisesService, ExercisesRepository],
})
export class ExercisesModule {}
