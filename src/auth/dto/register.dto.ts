import { Equals, IsEmail, IsString, MaxLength, MinLength } from "class-validator";

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

  // RGPD — les trois cases sont obligatoires (refus = 400, aucun compte créé) :
  // politique de confidentialité, consentement explicite aux données de santé
  // (art. 9 : état de forme, poids), et 15 ans ou accord du représentant légal.
  @Equals(true, { message: "Tu dois accepter la politique de confidentialité" })
  acceptPrivacyPolicy!: boolean;

  @Equals(true, { message: "Ton accord pour les données de santé est nécessaire" })
  acceptHealthData!: boolean;

  @Equals(true, { message: "Tu dois avoir 15 ans ou l'accord de ton représentant légal" })
  confirmAgeOrParentalConsent!: boolean;
}
