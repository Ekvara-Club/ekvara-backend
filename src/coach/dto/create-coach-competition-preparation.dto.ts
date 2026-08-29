import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { PREPARATION_STATUSES } from "../coach-competition-preparation-status";

// status omis -> DEFAULT_PREPARATION_STATUS ("envisage") appliqué côté
// service, jamais une valeur par défaut dupliquée ici dans le DTO.
export class CreateCoachCompetitionPreparationDto {
  @IsUUID()
  athleteId!: string;

  @IsOptional()
  @IsIn(PREPARATION_STATUSES)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  targetAgeCategory?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  targetWeightCategory?: string;

  @IsOptional()
  @IsString()
  objective?: string;

  @IsOptional()
  @IsString()
  coachNote?: string;
}
