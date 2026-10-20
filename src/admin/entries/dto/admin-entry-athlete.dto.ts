import { IsUUID } from "class-validator";

// Association explicite d'un participant à une fiche athlète
// (external_athlete), choisie par l'administrateur — jamais déduite du nom.
export class AdminEntryAthleteDto {
  @IsUUID("all", { message: "Identifiant de fiche athlète invalide" })
  externalAthleteId!: string;
}
