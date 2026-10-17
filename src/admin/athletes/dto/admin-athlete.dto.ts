import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf } from "class-validator";
import { GENDERS } from "../admin-athlete-rules";

// Validation de FORME (types, longueurs = colonnes Prisma). Validation
// métier (date réelle, bornes) : AdminAthletesService.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const COUNTRY_RE = /^[A-Z]{3}$/;
const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value);
// Facultatif : vide -> null (inconnu), jamais une valeur devinée.
const trimToNull = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() || null : value);
// Code NOC tel que publié (FRA, KOR, AIN...) : majuscules, jamais converti.
const upperToNull = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim().toUpperCase() || null : value);

const COUNTRY_MESSAGE = "Le code pays doit comporter 3 lettres (code NOC, ex. FRA)";
const GENDER_MESSAGE = `Le genre doit valoir ${GENDERS.join(" ou ")} (ou rester inconnu)`;
const DAY_MESSAGE = "La date de naissance doit être au format AAAA-MM-JJ";

export class AdminAthleteCreateDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: "Le nom est obligatoire" })
  @MaxLength(255)
  displayName!: string;

  @Transform(upperToNull)
  @IsOptional()
  @IsString()
  @Matches(COUNTRY_RE, { message: COUNTRY_MESSAGE })
  countryCode?: string | null;

  @Transform(trimToNull)
  @IsOptional()
  @IsIn(GENDERS, { message: GENDER_MESSAGE })
  gender?: string | null;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @Matches(DAY_RE, { message: DAY_MESSAGE })
  birthDate?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID("all", { each: true })
  acknowledgedDuplicateIds?: string[];
}

// Modification partielle : absent = inchangé ; null = effacer un champ
// facultatif ; le nom ne peut jamais être effacé.
export class AdminAthleteUpdateDto {
  @ValidateIf((o: AdminAthleteUpdateDto) => o.displayName !== undefined)
  @Transform(trim)
  @IsString({ message: "Le nom est obligatoire" })
  @IsNotEmpty({ message: "Le nom est obligatoire" })
  @MaxLength(255)
  displayName?: string;

  @Transform(upperToNull)
  @IsOptional()
  @IsString()
  @Matches(COUNTRY_RE, { message: COUNTRY_MESSAGE })
  countryCode?: string | null;

  @Transform(trimToNull)
  @IsOptional()
  @IsIn(GENDERS, { message: GENDER_MESSAGE })
  gender?: string | null;

  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @Matches(DAY_RE, { message: DAY_MESSAGE })
  birthDate?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID("all", { each: true })
  acknowledgedDuplicateIds?: string[];
}

export class AdminAthleteListQueryDto {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @Transform(upperToNull)
  @IsOptional()
  @IsString()
  @Matches(COUNTRY_RE, { message: COUNTRY_MESSAGE })
  country?: string;

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
  @IsIn(["all", "manual", "imported"])
  origin?: "all" | "manual" | "imported";
}
