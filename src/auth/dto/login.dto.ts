import { IsEmail, IsNotEmpty, IsString } from "class-validator";

export class LoginDto {
  @IsEmail()
  email!: string;

  // Pas de @MinLength ici : ne jamais révéler la politique de mot de passe
  // via une erreur de validation sur le login, et un mot de passe existant
  // plus court doit tout de même pouvoir se connecter.
  @IsString()
  @IsNotEmpty()
  password!: string;
}
