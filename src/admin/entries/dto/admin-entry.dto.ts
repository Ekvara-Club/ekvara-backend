import { Transform } from "class-transformer";
import { ArrayMaxSize, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { GENDERS } from "../../athletes/admin-athlete-rules";

const collapse = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value);
// Facultatif : vide -> null (inconnu), jamais une valeur devinée.
const trimToNull = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") || null : value);

// Participant complet (création ET modification : la modification remplace
// toutes les valeurs saisies). Longueurs = colonnes competition_entry.
export class AdminEntryDto {
  @Transform(collapse)
  @IsString()
  @IsNotEmpty({ message: "Le nom du participant est obligatoire" })
  @MaxLength(255)
  participantName!: string;

  // = source_category_raw_label : libellé de catégorie tel que saisi.
  @Transform(collapse)
  @IsString()
  @IsNotEmpty({ message: "La catégorie est obligatoire" })
  @MaxLength(255)
  category!: string;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  ageCategory?: string | null;

  @Transform(trimToNull)
  @IsOptional()
  @IsIn(GENDERS, { message: `Le genre doit valoir ${GENDERS.join(" ou ")} (ou rester inconnu)` })
  gender?: string | null;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  weightCategory?: string | null;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(255)
  club?: string | null;

  // Libellé texte (ex. "France"), même convention que les inscrits importés —
  // jamais converti en code NOC.
  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string | null;

  // Fiche athlète (external_athlete) choisie explicitement dans la base ;
  // absente ou vide = participant sans fiche liée. Jamais un compte EKVARA.
  @Transform(trimToNull)
  @IsOptional()
  @IsUUID("all", { message: "Identifiant de fiche athlète invalide" })
  externalAthleteId?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID("all", { each: true })
  acknowledgedDuplicateIds?: string[];
}
