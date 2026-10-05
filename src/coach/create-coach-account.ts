import * as argon2 from "argon2";
import { PrismaService } from "../prisma/prisma.service";

export interface CreateCoachAccountInput {
  email: string;
  password: string;
  prenom: string;
  nom: string;
  clubName: string;
  clubVille?: string;
  clubPays?: string;
}

// Aucun endpoint ne crée de compte coach (les athlètes s'inscrivent sur
// invitation d'un coach) : sur une base de production neuve, le premier coach
// et son club sont créés par la CLI create-coach.cli.ts, qui appelle cette
// fonction. Mêmes règles que AuthService.register (email normalisé, mot de
// passe 8..255, argon2id) ; un email déjà utilisé est refusé, jamais
// réécrit. Club réutilisé s'il existe déjà avec ce nom exact.
export async function createCoachAccount(prisma: PrismaService, input: CreateCoachAccountInput) {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Email invalide");
  if (input.password.length < 8 || input.password.length > 255) {
    throw new Error("Le mot de passe doit contenir entre 8 et 255 caractères");
  }
  const clubName = input.clubName.trim();
  if (!clubName) throw new Error("Nom de club obligatoire");

  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });

  return prisma.$transaction(async (tx) => {
    const existing = await tx.app_user.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw new Error(`Un compte existe déjà avec l'email ${email}`);

    const club =
      (await tx.club.findFirst({ where: { nom: clubName }, select: { id: true, nom: true } })) ??
      (await tx.club.create({
        data: { nom: clubName, ville: input.clubVille?.trim() || null, pays: input.clubPays?.trim() || null },
        select: { id: true, nom: true },
      }));

    const user = await tx.app_user.create({
      data: { email, password_hash: passwordHash, prenom: input.prenom.trim(), nom: input.nom.trim() },
      select: { id: true, email: true },
    });
    const coach = await tx.coach_profile.create({
      data: { user_id: user.id, club_id: club.id },
      select: { id: true },
    });

    return { userId: user.id, coachId: coach.id, email: user.email, clubId: club.id, clubName: club.nom };
  });
}
