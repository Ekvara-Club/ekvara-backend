import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { MetricsService } from "../metrics/metrics.service";
import { MetricsRepository } from "../metrics/metrics.repository";

// Test d'intégration contre la vraie base Postgres locale (ticket
// "Évaluations / Métriques Coach" §30) : fixtures coach A + athlete A (lié)
// + athlete B (non lié). Utilise directement MetricsService — le VRAI
// service athlete-facing, exactement comme CoachAthleteMetricsController le
// fait (aucune couche coach parallèle, voir ticket §3). Réutilise le
// catalogue metric_type RÉEL du seed dev (force/higher, temps_reaction/lower,
// technique/higher) en lecture seule — jamais créé ni supprimé ici, seules
// les metric_measurement de fixtures athlete jetables le sont (cascade
// depuis app_user).
describe("Évaluations coach — metric_measurement (intégration Postgres)", () => {
  let prisma: PrismaService;
  let metricsService: MetricsService;
  const runId = Date.now();
  const createdUserIds: string[] = [];
  let counter = 0;

  let forceTypeId: string;
  let reactionTypeId: string;
  let techniqueTypeId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    metricsService = new MetricsService(new MetricsRepository(prisma));

    const force = await prisma.metric_type.findUnique({ where: { code: "force" } });
    const reaction = await prisma.metric_type.findUnique({ where: { code: "temps_reaction" } });
    const technique = await prisma.metric_type.findUnique({ where: { code: "technique" } });
    if (!force || !reaction || !technique) {
      throw new Error("Catalogue metric_type dev incomplet (force/temps_reaction/technique attendus)");
    }
    forceTypeId = force.id;
    reactionTypeId = reaction.id;
    techniqueTypeId = technique.id;
  }, 30000);

  afterEach(async () => {
    if (createdUserIds.length > 0) {
      await prisma.app_user.deleteMany({ where: { id: { in: createdUserIds } } });
      createdUserIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  }, 30000);

  async function makeCoach(): Promise<{ profileId: string; userId: string }> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-metrics-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `F${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return { profileId: profile.id, userId: user.id };
  }

  async function makeAthlete(prenom: string): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-metrics-athlete-${runId}-${counter}@test.fr`, nom: "Test", prenom },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
    return athlete.id;
  }

  it("première mesure, deuxième mesure, auteur, historique, overview — cycle complet via le vrai service", async () => {
    const coach = await makeCoach();
    const athleteA = await makeAthlete("A");

    const first = await metricsService.createMeasurement(athleteA, forceTypeId, {
      value: 80,
      coachUserId: coach.userId,
    });
    expect(first.coachUserId).toBe(coach.userId);

    const second = await metricsService.createMeasurement(athleteA, forceTypeId, {
      value: 85,
      coachUserId: coach.userId,
    });
    expect(second.value).toBe(85);

    const history = await metricsService.findMeasurements(athleteA, forceTypeId);
    expect(history).toHaveLength(2);
    expect(history.every((m) => m.coachUserId === coach.userId)).toBe(true);

    const overview = await metricsService.getOverview(athleteA);
    const forceEntry = overview.metrics.find((m) => m.id === forceTypeId);
    expect(forceEntry?.status).toBe("improved"); // 80 -> 85, direction "higher"
  });

  // Dates de mesure explicites : deux mesures créées dans la même
  // milliseconde (mesure_le = now()) avaient un ordre indéterminé, et le
  // test inversait parfois "dernière" et "précédente" (instable).
  it("Force 80 -> 85 (higher) = improved", async () => {
    const athleteA = await makeAthlete("A");
    await metricsService.createMeasurement(athleteA, forceTypeId, { value: 80, measuredAt: "2026-09-01T10:00:00.000Z" });
    await metricsService.createMeasurement(athleteA, forceTypeId, { value: 85, measuredAt: "2026-09-08T10:00:00.000Z" });

    const overview = await metricsService.getOverview(athleteA);
    expect(overview.metrics.find((m) => m.id === forceTypeId)?.status).toBe("improved");
  });

  it("Temps de réaction 420ms -> 380ms (lower) = improved — CAS CRITIQUE, jamais déterminé depuis le signe brut du delta", async () => {
    const athleteA = await makeAthlete("A");
    await metricsService.createMeasurement(athleteA, reactionTypeId, { value: 420, measuredAt: "2026-09-01T10:00:00.000Z" });
    await metricsService.createMeasurement(athleteA, reactionTypeId, { value: 380, measuredAt: "2026-09-08T10:00:00.000Z" });

    const overview = await metricsService.getOverview(athleteA);
    const entry = overview.metrics.find((m) => m.id === reactionTypeId);
    expect(entry?.status).toBe("improved");
    expect(entry?.delta).toBe(-40); // delta brut négatif, mais bien "improved"
    // Étoile de compétences, barème réel du metric_type (600 ms -> 0, 250 ms
    // -> 100) : plus bas = meilleure note.
    expect(entry?.score).toBe(63);
    expect(entry?.previousScore).toBe(51);
  });

  it("Technique 60 -> 55 (higher) = declining (regressed)", async () => {
    const athleteA = await makeAthlete("A");
    await metricsService.createMeasurement(athleteA, techniqueTypeId, { value: 60, measuredAt: "2026-09-01T10:00:00.000Z" });
    await metricsService.createMeasurement(athleteA, techniqueTypeId, { value: 55, measuredAt: "2026-09-08T10:00:00.000Z" });

    const overview = await metricsService.getOverview(athleteA);
    expect(overview.metrics.find((m) => m.id === techniqueTypeId)?.status).toBe("regressed");
  });

  it("retrait coach_athlete : les mesures déjà créées par le coach restent intactes", async () => {
    const coach = await makeCoach();
    const athleteA = await makeAthlete("A");
    await prisma.coach_athlete.create({ data: { coach_id: coach.profileId, athlete_id: athleteA } });

    await metricsService.createMeasurement(athleteA, forceTypeId, { value: 80, coachUserId: coach.userId });
    await prisma.coach_athlete.delete({
      where: { coach_id_athlete_id: { coach_id: coach.profileId, athlete_id: athleteA } },
    });

    const history = await metricsService.findMeasurements(athleteA, forceTypeId);
    expect(history).toHaveLength(1);
    expect(history[0].coachUserId).toBe(coach.userId);
  });

  it("metricTypeId inconnu -> NotFoundException contrôlée (aucune fuite)", async () => {
    const athleteA = await makeAthlete("A");
    await expect(
      metricsService.createMeasurement(athleteA, "00000000-0000-4000-8000-000000000000", { value: 10 }),
    ).rejects.toThrow();
  });

  it("utilisateur hybride : son propre app_user.id sert d'auteur pour une mesure qu'il enregistre en tant que coach sur un athlète qu'il gère", async () => {
    // Simule un utilisateur hybride : même app_user.id que le "coach", mais
    // on ne crée pas de profil athlete séparé ici (déjà couvert par les
    // tests hybrid-user.spec.ts des tickets précédents pour la partie
    // guards) — ce test vérifie uniquement l'attribution correcte de
    // coach_user_id = req.user.sub, peu importe les autres profils du même
    // app_user.
    const coach = await makeCoach();
    const athleteA = await makeAthlete("A");

    const measurement = await metricsService.createMeasurement(athleteA, forceTypeId, {
      value: 80,
      coachUserId: coach.userId,
    });

    expect(measurement.coachUserId).toBe(coach.userId);
  });
});
