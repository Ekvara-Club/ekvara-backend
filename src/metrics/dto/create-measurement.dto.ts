import { IsDateString, IsNumber, IsOptional, IsString, IsUUID } from "class-validator";

export class CreateMeasurementDto {
  @IsNumber()
  value!: number;

  @IsOptional()
  @IsDateString()
  measuredAt?: string;

  @IsOptional()
  @IsUUID()
  coachUserId?: string;

  @IsOptional()
  @IsString()
  comment?: string;
}
