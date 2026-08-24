import { IsEmail, MaxLength } from "class-validator";

export class AddCoachAthleteDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;
}
