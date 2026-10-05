import { IsUUID } from "class-validator";

export class RequestWtLinkDto {
  @IsUUID()
  externalAthleteId!: string;
}
