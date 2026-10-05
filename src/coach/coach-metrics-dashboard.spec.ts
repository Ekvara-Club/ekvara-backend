import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { MetricsService } from "../metrics/metrics.service";
import { MetricsRepository } from "../metrics/metrics.repository";
import { CoachRepository } from "./coach.repository";
import { CoachGroupsRepository } from "./coach-groups.repository";
import { CoachDashboardRepository } from "./coach-dashboard.repository";
import { CoachDashboardService } from "./coach-dashboard.service";

// Ticket "Évaluations / Métriques Coach" §19/§32 : le dashboard coach
// (ticket #2, non modifié dans ce ticket) doit refléter IMMÉDIATEMENT une
// mesure créée par le coach — ses batch queries lisent directement
// metric_measurement, donc aucune logique spéciale n'est nécessaire, mais
// c'est vérifié ici contre la vraie base, pas supposé (même principe que
// coach-pilotage-downstream.spec.ts, ticket #5).
describe("Dashboard coach — réaction aux mesures (intégration Postgres)", () => {
  let prisma: PrismaService;
  let metricsService: MetricsService;
  let dashboardService: CoachDashboardService;
  const runId = Date.now();
  const createdUserIds: string[] = [];
  let counter = 0;
  let reactionTypeId: string;
  let metricTypeCount: number;

  beforeAll(async () => {
    prisma = new PrismaService();
    const metricsRepository = new MetricsRepository(prisma);
    metricsService = new MetricsService(metricsRepository);
    dashboardService = new CoachDashboardService(
      new CoachRepository(prisma),
      new CoachGroupsRepository(prisma),
      new CoachDashboardRepository(prisma, metricsRepository),
    );

    const reaction = await prisma.metric_type.findUnique({ where: { code: "temps_reaction" } });
    if (!reaction) throw new Error("metric_type 'temps_reaction' absent du seed dev");
    reactionTypeId = reaction.id;
    // Compté dynamiquement plutôt que codé en dur : ce test ne doit pas
    // casser si le catalogue metric_type dev évolue (ajout/retrait d'un type).
    metricTypeCount = await prisma.metric_type.count();
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

  async function makeCoach(): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-mdash-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `F${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return profile.id;
  }

  async function makeAthlete(prenom: string): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-mdash-athlete-${runId}-${counter}@test.fr`, nom: "Test", prenom },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
    return athlete.id;
  }

  it("avant mesure : unknown/no-data ; après 2 mesures (temps de réaction, improved) : dashboard athlète et global actualisés", async () => {
    const coachId = await makeCoach();
    const athleteA = await makeAthlete("A");
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteA } });

    const before = await dashboardService.getAthleteDashboard(coachId, athleteA);
    expect(before.progression).toEqual({
      improvedCount: 0,
      decliningCount: 0,
      unknownCount: metricTypeCount, // tous les metric_type connus, aucune mesure -> unknown
      evaluatedCount: 0,
      overallStatus: null,
    });
    const beforeGlobal = await dashboardService.getDashboard(coachId);
    expect(beforeGlobal.summary.athletesWithoutRecentMetrics).toBe(1);

    // Dates explicites : deux mesures créées dans la même milliseconde
    // (mesure_le = now()) avaient un ordre indéterminé (test instable).
    await metricsService.createMeasurement(athleteA, reactionTypeId, { value: 420, measuredAt: "2026-09-01T10:00:00.000Z" });
    await metricsService.createMeasurement(athleteA, reactionTypeId, { value: 380, measuredAt: "2026-09-08T10:00:00.000Z" });

    const after = await dashboardService.getAthleteDashboard(coachId, athleteA);
    expect(after.progression.improvedCount).toBe(1);
    expect(after.progression.evaluatedCount).toBe(1);
    expect(after.progression.unknownCount).toBe(metricTypeCount - 1);

    const afterGlobal = await dashboardService.getDashboard(coachId);
    expect(afterGlobal.summary.athletesImproving).toBe(1);
    expect(afterGlobal.summary.athletesWithoutRecentMetrics).toBe(0);
  });
});
