import { IsOptional, IsString, IsUrl, MaxLength } from "class-validator";

// Tous les champs optionnels ; CoachExercisesService exige qu'au moins un
// soit fourni (même politique que UpdateCoachTrainingDto).
export class UpdateCoachExerciseDto {
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
  panelTechnique?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  level?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsUrl()
  videoUrl?: string;
}
