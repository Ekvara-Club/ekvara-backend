import { IsDateString, IsOptional, IsString, MaxLength } from "class-validator";

// Modification du CONTENU uniquement (titre/horaire/etc.) — jamais les
// destinataires, voir ReplaceCoachTrainingAssignmentsDto pour ça (ticket
// §14/§15 : deux préoccupations différentes, deux endpoints). Tous les
// champs sont optionnels ; CoachTrainingsService exige qu'au moins un soit
// fourni (même politique que UpdateParticipationResultDto).
export class UpdateCoachTrainingDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  subType?: string;

  @IsOptional()
  @IsDateString()
  startAt?: string;

  @IsOptional()
  @IsDateString()
  endAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  level?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
