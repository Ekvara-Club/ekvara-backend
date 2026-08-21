import { IsInt, IsNotEmpty, IsOptional, IsString, Min, MaxLength } from "class-validator";

export class CreateGoalStepDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  titre!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  ordre?: number;
}
