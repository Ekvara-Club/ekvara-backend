import "dotenv/config";
import { PrismaService } from "../../prisma/prisma.service";
import { seedMetricTypes } from "./seed-metric-types";
import { METRIC_TYPES_SEED_DATA } from "./metric-types.seed-data";

// Intégration Postgres réelle. Ne supprime rien : sur la base de dev les 6
// capacités existent déjà -> le seed doit les laisser strictement intactes.
describe("seedMetricTypes (intégration Postgres)", () => {
  let prisma: PrismaService;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("toutes les capacités existent après le seed, avec un sens d'amélioration ; ré-exécution sans doublon ni modification", async () => {
    const before = await prisma.metric_type.findMany({ orderBy: { code: "asc" } });

    await seedMetricTypes(prisma);
    const second = await seedMetricTypes(prisma);

    expect(second).toEqual({ created: 0, skipped: METRIC_TYPES_SEED_DATA.length });
    for (const data of METRIC_TYPES_SEED_DATA) {
      const row = await prisma.metric_type.findUniqueOrThrow({ where: { code: data.code } });
      expect(["higher", "lower"]).toContain(row.improvement_direction);
    }
    const after = await prisma.metric_type.findMany({ where: { id: { in: before.map((b) => b.id) } }, orderBy: { code: "asc" } });
    expect(after).toEqual(before);
  });

  it("données du seed cohérentes : sens et barème dans le même sens", () => {
    for (const data of METRIC_TYPES_SEED_DATA) {
      if (data.improvement_direction === "higher") expect(data.score_hundred).toBeGreaterThan(data.score_zero);
      else expect(data.score_hundred).toBeLessThan(data.score_zero);
    }
  });
});
