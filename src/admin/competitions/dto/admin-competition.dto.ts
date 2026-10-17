import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";

// Validation de FORME uniquement (types, longueurs = colonnes Prisma,
// format de date). La validation métier (date réelle, bornes, fin >= début)
// est faite par AdminCompetitionsService, sur les valeurs fusionnées.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
// Champ facultatif : chaîne vide -> null (inconnu), jamais une valeur devinée.
const trimToNull = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() || null : value);

export class AdminCompetitionCreateDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: "Le nom est obligatoire" })
  @MaxLength(255)
  nom!: string;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(255)
  organisateur?: string | null;

  @Transform(trim)
  @IsString()
  @Matches(DAY_RE, { message: "La date de début doit être au format AAAA-MM-JJ" })
  dateDebut!: string;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @Matches(DAY_RE, { message: "La date de fin doit être au format AAAA-MM-JJ" })
  dateFin?: string | null;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(255)
  lieu?: string | null;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  ville?: string | null;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  pays?: string | null;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  niveau?: string | null;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(20)
  saison?: string | null;

  // Compétitions potentiellement identiques que l'administrateur a examinées
  // et confirmé comme distinctes (voir AdminCompetitionsService).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID("all", { each: true })
  acknowledgedDuplicateIds?: string[];
}

// Modification partielle : un champ absent n'est pas modifié ; null efface
// un champ facultatif ; nom et dateDebut ne peuvent jamais être effacés.
export class AdminCompetitionUpdateDto {
  @ValidateIf((o: AdminCompetitionUpdateDto) => o.nom !== undefined)
  @Transform(trim)
  @IsString({ message: "Le nom est obligatoire" })
  @IsNotEmpty({ message: "Le nom est obligatoire" })
  @MaxLength(255)
  nom?: string;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(255)
  organisateur?: string | null;

  @ValidateIf((o: AdminCompetitionUpdateDto) => o.dateDebut !== undefined)
  @Transform(trim)
  @IsString({ message: "La date de début est obligatoire" })
  @Matches(DAY_RE, { message: "La date de début doit être au format AAAA-MM-JJ" })
  dateDebut?: string;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @Matches(DAY_RE, { message: "La date de fin doit être au format AAAA-MM-JJ" })
  dateFin?: string | null;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(255)
  lieu?: string | null;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  ville?: string | null;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  pays?: string | null;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  niveau?: string | null;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(20)
  saison?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID("all", { each: true })
  acknowledgedDuplicateIds?: string[];
}

export class AdminCompetitionListQueryDto {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsIn(["asc", "desc"])
  sort?: "asc" | "desc";

  @IsOptional()
  @IsIn(["all", "manual", "imported"])
  origin?: "all" | "manual" | "imported";
}
