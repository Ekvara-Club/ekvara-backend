import * as argon2 from "argon2";
import { PrismaService } from "../prisma/prisma.service";

// Aucun « mot de passe oublié » par e-mail en V1 (pas d'envoi d'e-mail) :
// l'administrateur réinitialise le mot de passe à la demande, via la CLI
// reset-password.cli.ts. Mêmes règles que l'inscription (8..255, argon2id).
// Limite : les sessions déjà ouvertes (JWT) restent valides jusqu'à leur
// expiration (JWT_EXPIRES_IN) — aucune révocation de token en V1.
export async function resetPassword(prisma: PrismaService, rawEmail: string, password: string) {
  const email = rawEmail.trim().toLowerCase();
  if (password.length < 8 || password.length > 255) {
    throw new Error("Le mot de passe doit contenir entre 8 et 255 caractères");
  }
  const user = await prisma.app_user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`Aucun compte avec l'email ${email}`);

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await prisma.app_user.update({ where: { id: user.id }, data: { password_hash: passwordHash, updated_at: new Date() } });
  return { email };
}
