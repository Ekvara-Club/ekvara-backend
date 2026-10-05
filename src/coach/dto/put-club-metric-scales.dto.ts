import { Type } from "class-transformer";
import { ArrayUnique, IsArray, IsNumber, IsUUID, ValidateIf, ValidateNested } from "class-validator";

export class ClubMetricScaleItemDto {
  @IsUUID()
  metricTypeId!: string;

  // null = revenir au barème par défaut (les deux valeurs à null ensemble,
  // vérifié en service avec un message lisible).
  @ValidateIf((_o, value) => value !== null)
  @IsNumber()
  scoreZero!: number | null;

  @ValidateIf((_o, value) => value !== null)
  @IsNumber()
  scoreHundred!: number | null;
}

export class PutClubMetricScalesDto {
  @IsArray()
  @ArrayUnique((item: ClubMetricScaleItemDto) => item.metricTypeId)
  @ValidateNested({ each: true })
  @Type(() => ClubMetricScaleItemDto)
  scales!: ClubMetricScaleItemDto[];
}
