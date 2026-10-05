import {
  ArrayNotEmpty,
  ArrayUnique,
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
} from "class-validator";
import { SERIES_DURATION_MONTHS } from "../training-series.util";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Séance récurrente : mêmes champs de contenu et de destinataires que
// CreateCoachTrainingDto, mais l'horaire est exprimé en heure murale
// (startDate + startTime/endTime) au lieu d'instants ISO — la conversion
// Europe/Paris de CHAQUE occurrence se fait côté backend
// (training-series.util.ts), jamais une liste d'instants calculée par le
// client. groupIds/athleteIds : même règle que pour une séance isolée (union
// résolue non vide, vérifiée en service).
export class CreateCoachTrainingSeriesDto {
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
  subType?: string;

  @Matches(DATE_ONLY, { message: "startDate doit être au format YYYY-MM-DD" })
  startDate!: string;

  @Matches(TIME_HH_MM, { message: "startTime doit être au format HH:mm" })
  startTime!: string;

  @IsOptional()
  @Matches(TIME_HH_MM, { message: "endTime doit être au format HH:mm" })
  endTime?: string;

  // ISO 8601 : 1 = lundi ... 7 = dimanche.
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  weekdays!: number[];

  @IsIn(SERIES_DURATION_MONTHS)
  durationMonths!: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  level?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID(4, { each: true })
  groupIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID(4, { each: true })
  athleteIds?: string[];
}
