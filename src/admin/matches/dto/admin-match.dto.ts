import { Transform } from "class-transformer";
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from "class-validator";
import { STAGES } from "../admin-match-rules";

const collapse = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value);
const trimToNull = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() || null : value);
const upperToNull = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim().toUpperCase() || null : value);

// Combat complet (création ET modification : la modification remplace toutes
// les valeurs saisies). Facultatif = inconnu = NULL, jamais deviné.
export class AdminMatchDto {
  @Transform(collapse)
  @IsString()
  @IsNotEmpty({ message: "La catégorie est obligatoire" })
  @MaxLength(100)
  category!: string;

  @Transform(trimToNull)
  @IsOptional()
  @IsIn(STAGES, { message: `Le tour doit valoir ${STAGES.join(", ")} (ou rester inconnu)` })
  bracketStage?: string | null;

  @IsOptional()
  @IsInt({ message: "Le numéro de combat doit être un entier" })
  @Min(0, { message: "Le numéro de combat ne peut pas être négatif" })
  @Max(100000)
  contestNumber?: number | null;

  @IsUUID("all", { message: "Athlète A invalide" })
  athleteAId!: string;

  @IsUUID("all", { message: "Athlète B invalide" })
  athleteBId!: string;

  @IsOptional()
  @IsInt({ message: "Le score A doit être un entier" })
  @Min(0, { message: "Un score ne peut pas être négatif" })
  @Max(999)
  scoreA?: number | null;

  @IsOptional()
  @IsInt({ message: "Le score B doit être un entier" })
  @Min(0, { message: "Un score ne peut pas être négatif" })
  @Max(999)
  scoreB?: number | null;

  // Côté du vainqueur : il appartient au combat par construction. Jamais
  // déduit des scores (RSC, DSQ, WDR...).
  @IsOptional()
  @IsIn(["A", "B"], { message: "Le vainqueur doit être l'athlète A ou l'athlète B (ou rester inconnu)" })
  winner?: "A" | "B" | null;

  // Code de méthode au format de l'import WT ("Won by PTF" -> PTF).
  @Transform(upperToNull)
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2,6}$/, { message: "La méthode doit être un code de 2 à 6 lettres (ex. PTF, RSC, DSQ)" })
  resultMethod?: string | null;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "La date du combat doit être au format AAAA-MM-JJ" })
  occurredOn?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID("all", { each: true })
  acknowledgedDuplicateIds?: string[];
}
