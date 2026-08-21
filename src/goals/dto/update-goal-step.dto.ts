import { IsBoolean } from "class-validator";

export class UpdateGoalStepDto {
  @IsBoolean()
  completed!: boolean;
}
