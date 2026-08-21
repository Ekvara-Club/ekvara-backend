import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { MetricsRepository } from "./metrics.repository";

// Test d'intégration contre la vraie base Postgres locale : le tri par
// mesure_le (et non created_at) et la sélection des deux dernières mesures
// sont une logique de requête Prisma qu'un mock ne peut pas valider
// sincèrement. Athlète et metric_type jetables, créés ici et nettoyés en
// afterAll — l'athlète de développement et les metric_type réels ne sont
// jamais touchés.
describe("MetricsRepository (intégration Postgres)", () => {
  let prisma: PrismaService;
  let repository: MetricsRepository;

  let athleteId: string;
  let userId: string;
  let metricTypeId: string;
  const measurementIds: string[] = [];

  const runId = Date.now();

  function daysAgo(offset: number, from = new Date()): Date {
    return new Date(from.getTime() - offset * 24 * 60 * 60 * 1000);
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    repository = new MetricsRepository(prisma);

    const user = await prisma.app_user.create({
      data: { email: `test-fixture-metrics-${runId}@test.fr`, nom: "Fixture", prenom: "Metrics" },
    });
    userId = user.id;
    const athlete = await prisma.athlete.create({ data: { user_id: userId } });
    athleteId = athlete.id;

    const metricType = await prisma.metric_type.create({
      data: {
        code: `test_metric_${runId}`,
        nom: "Metric de test",
        unite: "kg",
        improvement_direction: "higher",
      },
    });
    metricTypeId = metricType.id;
  }, 30000);

  afterEach(async () => {
    if (measurementIds.length > 0) {
      await prisma.metric_measurement.deleteMany({ where: { id: { in: measurementIds } } });
      measurementIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.metric_type.delete({ where: { id: metricTypeId } });
    await prisma.athlete.delete({ where: { id: athleteId } });
    await prisma.app_user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  }, 30000);

  it("createMeasurement persiste la valeur en tant que nombre lisible (Decimal converti)", async () => {
    const created = await repository.createMeasurement(athleteId, metricTypeId, {
      value: 90,
      measuredAt: new Date(),
      comment: "Test de force",
    });
    measurementIds.push(created.id);

    expect(created.valeur.toNumber()).toBe(90);
    expect(created.commentaire).toBe("Test de force");
  });

  it("findMeasurementsByAthleteAndMetric trie par mesure_le desc, pas created_at", async () => {
    const now = new Date();
    const rows = await Promise.all([
      // created_at (implicite, à l'insertion) est croissant dans cet ordre,
      // mais mesure_le est volontairement différent pour prouver le tri.
      repository.createMeasurement(athleteId, metricTypeId, { value: 70, measuredAt: daysAgo(10, now) }),
      repository.createMeasurement(athleteId, metricTypeId, { value: 90, measuredAt: now }),
      repository.createMeasurement(athleteId, metricTypeId, { value: 80, measuredAt: daysAgo(3, now) }),
    ]);
    measurementIds.push(...rows.map((r) => r.id));

    const history = await repository.findMeasurementsByAthleteAndMetric(athleteId, metricTypeId);
    const testRows = history.filter((h) => rows.some((r) => r.id === h.id));

    expect(testRows.map((h) => h.valeur.toNumber())).toEqual([90, 80, 70]);
  });

  it("findLastTwoMeasurements renvoie [actuelle, précédente] par mesure_le", async () => {
    const now = new Date();
    const rows = await Promise.all([
      repository.createMeasurement(athleteId, metricTypeId, { value: 80, measuredAt: daysAgo(20, now) }),
      repository.createMeasurement(athleteId, metricTypeId, { value: 85, measuredAt: daysAgo(10, now) }),
      repository.createMeasurement(athleteId, metricTypeId, { value: 90, measuredAt: now }),
    ]);
    measurementIds.push(...rows.map((r) => r.id));

    const [current, previous] = await repository.findLastTwoMeasurements(athleteId, metricTypeId);

    expect(current?.valeur.toNumber()).toBe(90);
    expect(previous?.valeur.toNumber()).toBe(85);
  });

  it("findLastTwoMeasurements renvoie [mesure, null] s'il n'y a qu'une seule mesure", async () => {
    const created = await repository.createMeasurement(athleteId, metricTypeId, {
      value: 90,
      measuredAt: new Date(),
    });
    measurementIds.push(created.id);

    const [current, previous] = await repository.findLastTwoMeasurements(athleteId, metricTypeId);

    expect(current?.id).toBe(created.id);
    expect(previous).toBeNull();
  });

  it("athleteExists / metricTypeExists / appUserExists", async () => {
    await expect(repository.athleteExists(athleteId)).resolves.toBe(true);
    await expect(repository.athleteExists("00000000-0000-0000-0000-000000000000")).resolves.toBe(false);

    await expect(repository.metricTypeExists(metricTypeId)).resolves.toBe(true);
    await expect(repository.metricTypeExists("00000000-0000-0000-0000-000000000000")).resolves.toBe(
      false,
    );

    await expect(repository.appUserExists(userId)).resolves.toBe(true);
    await expect(repository.appUserExists("00000000-0000-0000-0000-000000000000")).resolves.toBe(false);
  });
});
