import "dotenv/config";
import { PrismaService } from "../../prisma/prisma.service";
import { EXERCISES_SEED_DATA } from "./exercises.seed-data";

// Idempotent par vérification du titre : pas de champ dédié à ajouter au schéma
// juste pour le seed. Ré-exécutable sans jamais créer de doublons.
async function main() {
  const prisma = new PrismaService();
  let created = 0;
  let skipped = 0;

  try {
    for (const data of EXERCISES_SEED_DATA) {
      const existing = await prisma.exercise.findFirst({ where: { titre: data.titre } });
      if (existing) {
        skipped++;
        continue;
      }

      await prisma.exercise.create({ data });
      created++;
    }

    const total = await prisma.exercise.count();
    console.log(`Seed exercises terminé : ${created} créé(s), ${skipped} déjà présent(s) (ignoré(s)).`);
    console.log(`Nombre total d'exercices en base : ${total}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Échec du seed exercises:", error);
  process.exit(1);
});
