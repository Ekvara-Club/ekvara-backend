import { IsDateString, IsNumber, IsOptional, IsPositive, IsUUID } from "class-validator";

export class CreateWeightTargetDto {
  @IsNumber()
  @IsPositive()
  weight!: number;

  @IsOptional()
  @IsDateString()
  targetDate?: string;

  @IsOptional()
  @IsUUID()
  competitionId?: string;
}
