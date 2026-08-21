import { IsIn, IsInt, IsOptional, Min } from "class-validator";

const ALLOWED_MEDAILLES = ["or", "argent", "bronze"] as const;
type MedailleValue = (typeof ALLOWED_MEDAILLES)[number];

export class UpdateParticipationResultDto {
  // Pas de borne haute arbitraire : aucune donnée fiable ne justifie un
  // plafond métier (nombre de participants variable selon la compétition).
  @IsOptional()
  @IsInt()
  @Min(1)
  classement?: number;

  // Absent (undefined) -> ne touche pas à la médaille. `null` explicite ->
  // retire une médaille déjà enregistrée. Une des 3 valeurs -> l'enregistre.
  // @IsOptional() ignore déjà null/undefined ; @IsIn liste explicitement null
  // comme valeur légitime pour documenter l'intention, pas seulement s'appuyer
  // sur ce comportement implicite.
  @IsOptional()
  @IsIn([...ALLOWED_MEDAILLES, null])
  medaille?: MedailleValue | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  victoires?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  defaites?: number;
}
