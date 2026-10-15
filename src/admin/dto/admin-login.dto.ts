import { IsEmail, IsNotEmpty, IsString, MaxLength } from "class-validator";

// Même politique que LoginDto (aucune règle de mot de passe révélée) ; borne
// haute uniquement pour éviter un hachage argon2 sur une entrée démesurée.
export class AdminLoginDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  password!: string;
}
