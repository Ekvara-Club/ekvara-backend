import { Module } from "@nestjs/common";
import { AuthGuardsModule } from "../auth/auth-guards.module";
import { GoalsController } from "./goals.controller";
import { GoalsService } from "./goals.service";
import { GoalsRepository } from "./goals.repository";

@Module({
  imports: [AuthGuardsModule],
  controllers: [GoalsController],
  providers: [GoalsService, GoalsRepository],
})
export class GoalsModule {}
