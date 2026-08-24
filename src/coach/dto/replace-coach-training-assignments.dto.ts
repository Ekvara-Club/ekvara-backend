import { ArrayUnique, IsArray, IsUUID } from "class-validator";

// Remplacement COMPLET des destinataires (ticket §14) : les deux tableaux
// représentent l'état cible final, pas un delta. Chacun peut être un tableau
// vide (ex. ne garder que des athlètes individuels, groupIds: []), mais leur
// union résolue ne doit jamais être vide au global — vérifié en service.
export class ReplaceCoachTrainingAssignmentsDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID(4, { each: true })
  groupIds!: string[];

  @IsArray()
  @ArrayUnique()
  @IsUUID(4, { each: true })
  athleteIds!: string[];
}
