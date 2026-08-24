import { IsNotEmpty, IsString, MaxLength } from "class-validator";

// Partagé entre POST /coach/groups (création) et PATCH /coach/groups/:groupId
// (renommage) : même unique champ, même validation dans les deux cas.
export class CoachGroupNameDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;
}
