import { IsEmail, IsString, MaxLength, MinLength } from "class-validator";

export class RegisterDto {
  // Revalidé strictement au moment du register (voir AuthService.register /
  // InvitationsService.redeem) : avoir appelé /auth/invitations/validate
  // avant ne donne aucun droit, ce champ est systématiquement recontrôlé.
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  invitationCode!: string;

  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(255)
  password!: string;

  @IsString()
  @MaxLength(100)
  nom!: string;

  @IsString()
  @MaxLength(100)
  prenom!: string;
}
