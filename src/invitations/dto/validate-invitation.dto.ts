import { IsString, MaxLength, MinLength } from "class-validator";

export class ValidateInvitationDto {
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  code!: string;
}
