import { IsInt, IsOptional, Max, Min } from "class-validator";

// Bornes de saisie (cm entiers) : hors bornes = faute de frappe probable.
export const HEIGHT_CM = { min: 100, max: 250 } as const;
export const ARM_LENGTH_CM = { min: 40, max: 130 } as const;

// PUT = état complet : un champ absent ou null vaut "non renseigné", jamais
// "inchangé" (même convention que UpdateAthleteConditionDto).
export class UpdateAthleteMeasurementsDto {
  @IsOptional()
  @IsInt({ message: "La taille doit être un nombre entier de centimètres" })
  @Min(HEIGHT_CM.min, { message: `La taille doit être comprise entre ${HEIGHT_CM.min} et ${HEIGHT_CM.max} cm` })
  @Max(HEIGHT_CM.max, { message: `La taille doit être comprise entre ${HEIGHT_CM.min} et ${HEIGHT_CM.max} cm` })
  tailleCm?: number | null;

  @IsOptional()
  @IsInt({ message: "La longueur de bras doit être un nombre entier de centimètres" })
  @Min(ARM_LENGTH_CM.min, { message: `La longueur de bras doit être comprise entre ${ARM_LENGTH_CM.min} et ${ARM_LENGTH_CM.max} cm` })
  @Max(ARM_LENGTH_CM.max, { message: `La longueur de bras doit être comprise entre ${ARM_LENGTH_CM.min} et ${ARM_LENGTH_CM.max} cm` })
  longueurBrasCm?: number | null;
}
