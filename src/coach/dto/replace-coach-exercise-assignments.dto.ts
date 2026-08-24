import { ArrayUnique, IsArray, IsUUID } from "class-validator";

// Remplacement COMPLET des destinataires (ticket §14) — même sémantique que
// ReplaceCoachTrainingAssignmentsDto : état cible final, pas un delta.
export class ReplaceCoachExerciseAssignmentsDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID(4, { each: true })
  groupIds!: string[];

  @IsArray()
  @ArrayUnique()
  @IsUUID(4, { each: true })
  athleteIds!: string[];
}
