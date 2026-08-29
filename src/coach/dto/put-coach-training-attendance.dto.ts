import { Type } from "class-transformer";
import { ArrayUnique, IsArray, IsIn, IsOptional, IsString, IsUUID, ValidateNested } from "class-validator";
import { ATTENDANCE_STATUSES } from "../training-attendance-status";

export class AttendanceItemDto {
  @IsUUID()
  athleteId!: string;

  @IsIn(ATTENDANCE_STATUSES)
  status!: string;

  @IsOptional()
  @IsString()
  note?: string;
}

// Sémantique PUT = liste complète (ticket §12, décision V1 : "liste
// complète du roster de la séance") : `attendances` représente l'état final
// souhaité pour les athlètes envoyés, jamais un delta. Un athlète assigné à
// la séance mais absent de ce tableau reste "non renseigné" (son
// éventuelle ligne training_attendance existante n'est PAS supprimée par
// ce endpoint — la liste complète attendue est celle de TOUS les athlètes
// assignés, l'UI coach envoie systématiquement le roster entier).
export class PutCoachTrainingAttendanceDto {
  @IsArray()
  @ArrayUnique((item: AttendanceItemDto) => item.athleteId)
  @ValidateNested({ each: true })
  @Type(() => AttendanceItemDto)
  attendances!: AttendanceItemDto[];
}
