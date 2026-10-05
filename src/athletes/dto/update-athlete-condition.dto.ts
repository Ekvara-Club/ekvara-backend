import { IsIn, IsOptional, IsString, Matches, MaxLength } from "class-validator";
import { ATHLETE_CONDITIONS } from "../athlete-condition";

// PUT = état complet : un champ absent vaut "non renseigné" (null), jamais
// "inchangé". note et expectedReturn sont ignorés (remis à null) quand
// status = "actif" — voir AthletesService.updateCondition.
export class UpdateAthleteConditionDto {
  @IsIn(ATHLETE_CONDITIONS)
  status!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "expectedReturn doit être au format YYYY-MM-DD" })
  expectedReturn?: string;
}
