import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { WeightsRepository } from "./weights.repository";

// Test d'intégration contre la vraie base Postgres locale : le tri de l'historique
// et surtout la sélection de la "mesure de référence à ~7 jours" sont une logique
// de requête Prisma qu'un mock ne peut pas valider sincèrement. Toutes les données
// créées ici sont un athlète jetable dédié, nettoyé en afterAll — l'athlète de
// développement et les compétitions réelles ne sont jamais touchés.
describe("WeightsRepository (intégration Postgres)", () => {
  let prisma: PrismaService;
  let repository: WeightsRepository;

  let athleteId: string;
  let userId: string;
  const weightLogIds: string[] = [];
  const weightTargetIds: string[] = [];

  const runId = Date.now();

  function daysAgo(offset: number, from = new Date()): Date {
    return new Date(from.getTime() - offset * 24 * 60 * 60 * 1000);
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    repository = new WeightsRepository(prisma);

    const user = await prisma.app_user.create({
      data: { email: `test-fixture-weights-${runId}@test.fr`, nom: "Fixture", prenom: "Weights" },
    });
    userId = user.id;

    const athlete = await prisma.athlete.create({ data: { user_id: userId } });
    athleteId = athlete.id;
  }, 30000);

  afterEach(async () => {
    if (weightLogIds.length > 0) {
      await prisma.weight_log.deleteMany({ where: { id: { in: weightLogIds } } });
      weightLogIds.length = 0;
    }
    if (weightTargetIds.length > 0) {
      await prisma.weight_target.deleteMany({ where: { id: { in: weightTargetIds } } });
      weightTargetIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.athlete.delete({ where: { id: athleteId } });
    await prisma.app_user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  }, 30000);

  it("createWeightLog persiste le poids en tant que nombre lisible (Decimal converti)", async () => {
    const created = await repository.createWeightLog(athleteId, {
      weight: 74.5,
      measuredAt: new Date(),
      note: "Pesée après le déjeuner",
    });
    weightLogIds.push(created.id);

    expect(created.valeur_kg.toNumber()).toBe(74.5);
    expect(created.note).toBe("Pesée après le déjeuner");
  });

  it("findWeightLogsByAthlete trie du plus récent au plus ancien", async () => {
    const now = new Date();
    const logs = await Promise.all([
      repository.createWeightLog(athleteId, { weight: 74.8, measuredAt: daysAgo(10, now) }),
      repository.createWeightLog(athleteId, { weight: 74.6, measuredAt: daysAgo(3, now) }),
      repository.createWeightLog(athleteId, { weight: 74.5, measuredAt: now }),
    ]);
    weightLogIds.push(...logs.map((l) => l.id));

    const history = await repository.findWeightLogsByAthlete(athleteId);
    const testRows = history.filter((h) => logs.some((l) => l.id === h.id));

    expect(testRows.map((h) => h.valeur_kg.toNumber())).toEqual([74.5, 74.6, 74.8]);
  });

  it("findReferenceWeightLog sélectionne la mesure la plus proche d'une semaine sans être plus récente", async () => {
    const now = new Date();
    const logs = await Promise.all([
      repository.createWeightLog(athleteId, { weight: 74.9, measuredAt: daysAgo(10, now) }),
      repository.createWeightLog(athleteId, { weight: 74.8, measuredAt: daysAgo(8, now) }),
      repository.createWeightLog(athleteId, { weight: 74.7, measuredAt: daysAgo(5, now) }), // trop récente (< 7j)
      repository.createWeightLog(athleteId, { weight: 74.5, measuredAt: now }),
    ]);
    weightLogIds.push(...logs.map((l) => l.id));

    const cutoff = daysAgo(7, now);
    const reference = await repository.findReferenceWeightLog(athleteId, cutoff);

    expect(reference?.valeur_kg.toNumber()).toBe(74.8);
  });

  it("findReferenceWeightLog renvoie null si aucune mesure n'a au moins 7 jours", async () => {
    const now = new Date();
    const log = await repository.createWeightLog(athleteId, { weight: 74.5, measuredAt: now });
    weightLogIds.push(log.id);

    const cutoff = daysAgo(7, now);
    const reference = await repository.findReferenceWeightLog(athleteId, cutoff);

    expect(reference).toBeNull();
  });

  it("findActiveWeightTarget retrouve l'objectif actif de l'athlète", async () => {
    const created = await repository.replaceActiveWeightTarget(athleteId, { weight: 74.0 });
    weightTargetIds.push(created.id);

    const active = await repository.findActiveWeightTarget(athleteId);

    expect(active?.id).toBe(created.id);
    expect(active?.poids_cible_kg.toNumber()).toBe(74.0);
    expect(active?.actif).toBe(true);
  });

  it("replaceActiveWeightTarget désactive l'ancien objectif sans le supprimer et active le nouveau", async () => {
    const first = await repository.replaceActiveWeightTarget(athleteId, { weight: 75.0 });
    const second = await repository.replaceActiveWeightTarget(athleteId, { weight: 74.0 });
    weightTargetIds.push(first.id, second.id);

    const firstReloaded = await prisma.weight_target.findUnique({ where: { id: first.id } });
    const secondReloaded = await prisma.weight_target.findUnique({ where: { id: second.id } });

    expect(firstReloaded).not.toBeNull(); // toujours en base : historique conservé
    expect(firstReloaded?.actif).toBe(false);
    expect(secondReloaded?.actif).toBe(true);

    const active = await repository.findActiveWeightTarget(athleteId);
    expect(active?.id).toBe(second.id);
  });
});
