import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { PREPARATION_STATUSES } from "../coach-competition-preparation-status";

// Jamais athleteId ni coachId ici (ticket §18) : impossible de spoofer un
// déplacement de préparation vers un autre athlète ou un autre coach — le
// DTO ne les accepte tout simplement pas (ValidationPipe whitelist rejette
// tout champ non déclaré, voir convention déjà établie sur les autres
// contrôleurs coach).
export class UpdateCoachCompetitionPreparationDto {
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
