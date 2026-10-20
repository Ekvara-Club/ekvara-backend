import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, ValidateNested } from "class-validator";
import { AdminEntryDto } from "./admin-entry.dto";

// Ajout groupé de participants (sélection d'athlètes existants ou liste
// importée par le portail) : chaque ligne est un participant complet, validé
// exactement comme une saisie unitaire, avec ses propres doublons confirmés.
export const BULK_ENTRIES_MAX = 200;

export class AdminEntryBulkDto {
  @IsArray()
  @ArrayMinSize(1, { message: "Au moins un participant est requis" })
  @ArrayMaxSize(BULK_ENTRIES_MAX, { message: `Au plus ${BULK_ENTRIES_MAX} participants par envoi` })
  @ValidateNested({ each: true })
  @Type(() => AdminEntryDto)
  entries!: AdminEntryDto[];
}
