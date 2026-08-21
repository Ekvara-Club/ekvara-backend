import { IsDateString, IsNumber, IsOptional, IsPositive, IsString } from "class-validator";

export class CreateWeightLogDto {
  @IsNumber()
  @IsPositive()
  weight!: number;

  @IsOptional()
  @IsDateString()
  measuredAt?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
