import { ArrayUnique, IsArray, IsDateString, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

// Mêmes champs métier que CreateTrainingDto (athlete-facing) — voir
// TrainingsService : la séance générée par athlète assigné doit être
// indiscernable d'une séance créée directement par cet athlète. groupIds et
// athleteIds sont indépendamment optionnels (chacun peut être omis), mais
// leur union résolue ne doit jamais être vide — vérifié en service (pas
// exprimable proprement en validation déclarative sur deux champs distincts).
export class CreateCoachTrainingDto {
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

  @IsDateString()
  startAt!: string;

  @IsOptional()
  @IsDateString()
  endAt?: string;

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
