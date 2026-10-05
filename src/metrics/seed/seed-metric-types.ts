import { PrismaService } from "../../prisma/prisma.service";
import { METRIC_TYPES_SEED_DATA } from "./metric-types.seed-data";

// Idempotent par code (unique) : crée les capacités manquantes, ne modifie
// JAMAIS une capacité existante (nom, sens ou barème déjà ajustés restent
// tels quels). Ré-exécutable sans risque.
export async function seedMetricTypes(prisma: PrismaService): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;
  for (const data of METRIC_TYPES_SEED_DATA) {
    const existing = await prisma.metric_type.findUnique({ where: { code: data.code }, select: { id: true } });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.metric_type.create({ data: { ...data } });
    created++;
  }
  return { created, skipped };
}
