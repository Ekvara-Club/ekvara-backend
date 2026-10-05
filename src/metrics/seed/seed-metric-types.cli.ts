import "dotenv/config";
import { PrismaService } from "../../prisma/prisma.service";
import { seedMetricTypes } from "./seed-metric-types";

//   npm run seed:metrics
async function main() {
  const prisma = new PrismaService();
  try {
    const { created, skipped } = await seedMetricTypes(prisma);
    console.log(`Seed capacités terminé : ${created} créée(s), ${skipped} déjà présente(s) (inchangée(s)).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Échec du seed capacités:", error);
  process.exit(1);
});
