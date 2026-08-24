import { IsNotEmpty, IsOptional, IsString, IsUrl, MaxLength } from "class-validator";

// Mêmes champs métier que le modèle `exercise` existant (voir
// ExercisesRepository.EXERCISE_SELECT) — aucun champ inventé (pas de
// séries/reps/durée/matériel, voir ticket §5). Jamais de coachId ici : il
// vient exclusivement du JWT (voir CoachExercisesController). Pas de champ
// `gratuit` : dormant côté backend (aucune logique ne le lit nulle part,
// voir rapport d'audit), sans lien opérationnel avec la visibilité coach —
// ne pas lui inventer un sens ici.
export class CreateCoachExerciseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

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
