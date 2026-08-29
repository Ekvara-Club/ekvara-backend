import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { CoachRepository } from "./coach.repository";
import { CoachGroupsRepository } from "./coach-groups.repository";
import { CoachDashboardRepository } from "./coach-dashboard.repository";
import { CoachDashboardService } from "./coach-dashboard.service";
import { MetricsRepository } from "../metrics/metrics.repository";
import { CoachTrainingsRepository } from "./coach-trainings.repository";
import { CoachTrainingAttendanceService } from "./coach-training-attendance.service";
import { CoachTrainingAttendanceRepository } from "./coach-training-attendance.repository";
import { CoachCompetitionPreparationsRepository } from "./coach-competition-preparations.repository";
import { CoachGroupDashboardService } from "./coach-group-dashboard.service";

// Ticket "Dashboard groupe Coach V1" §36-38/§71 : preuve que
// CoachGroupDashboardService.getGroupDashboard n'exécute jamais de requête
// par athlète — même instrumentation que coach-dashboard.performance.spec.ts
// (proxy Prisma comptant chaque appel de méthode sur un model delegate),
// comparée à 1, 5 et 20 athlètes dans le groupe.
describe("CoachGroupDashboardService — performance (intégration Postgres)", () => {
  let prisma: PrismaService;
  const runId = Date.now();
  const createdUserIds: string[] = [];
  let counter = 0;

  beforeAll(() => {
    prisma = new PrismaService();
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

  function withQueryCounter(target: PrismaService): { proxied: PrismaService; count: () => number } {
    let count = 0;
    const modelProxies = new Map<PropertyKey, unknown>();
    const proxied = new Proxy(target as unknown as Record<PropertyKey, unknown>, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver);
        if (typeof value !== "object" || value === null) return value;
        if (typeof (value as Record<string, unknown>).findMany !== "function") return value;
        if (modelProxies.has(prop)) return modelProxies.get(prop);
        const modelProxy = new Proxy(value as Record<PropertyKey, unknown>, {
          get(modelObj, method, modelReceiver) {
            const fn = Reflect.get(modelObj, method, modelReceiver);
            if (typeof fn !== "function") return fn;
            return (...args: unknown[]) => {
              count++;
              return (fn as (...a: unknown[]) => unknown).apply(modelObj, args);
            };
          },
        });
        modelProxies.set(prop, modelProxy);
        return modelProxy;
      },
    });
    return { proxied: proxied as unknown as PrismaService, count: () => count };
  }

  function buildService(proxiedPrisma: PrismaService): CoachGroupDashboardService {
    const metricsRepository = new MetricsRepository(proxiedPrisma);
    const dashboardService = new CoachDashboardService(
      new CoachRepository(proxiedPrisma),
      new CoachGroupsRepository(proxiedPrisma),
      new CoachDashboardRepository(proxiedPrisma, metricsRepository),
    );
    const attendanceService = new CoachTrainingAttendanceService(new CoachTrainingAttendanceRepository(proxiedPrisma));
    return new CoachGroupDashboardService(
      new CoachGroupsRepository(proxiedPrisma),
      dashboardService,
      attendanceService,
      new CoachTrainingsRepository(proxiedPrisma),
      new CoachCompetitionPreparationsRepository(proxiedPrisma),
    );
  }

  async function makeCoach(): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-groupdash-perf-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `P${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return profile.id;
  }

  async function makeGroupWithAthletes(coachId: string, size: number): Promise<string> {
    counter += 1;
    const group = await prisma.coach_group.create({ data: { coach_id: coachId, name: `Perf ${runId}-${counter}` } });
    for (let i = 0; i < size; i++) {
      counter += 1;
      const user = await prisma.app_user.create({
        data: { email: `test-groupdash-perf-athlete-${runId}-${counter}@test.fr`, nom: "Test", prenom: `A${counter}` },
      });
      createdUserIds.push(user.id);
      const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athlete.id } });
      await prisma.coach_group_athlete.create({ data: { group_id: group.id, athlete_id: athlete.id } });
    }
    return group.id;
  }

  it("nombre de requêtes constant, indépendant du nombre d'athlètes (1, 5, 20)", async () => {
    const coach1 = await makeCoach();
    const group1 = await makeGroupWithAthletes(coach1, 1);
    const { proxied: p1, count: c1 } = withQueryCounter(prisma);
    await buildService(p1).getGroupDashboard(coach1, group1);
    const queryCount1 = c1();

    const coach5 = await makeCoach();
    const group5 = await makeGroupWithAthletes(coach5, 5);
    const { proxied: p5, count: c5 } = withQueryCounter(prisma);
    await buildService(p5).getGroupDashboard(coach5, group5);
    const queryCount5 = c5();

    const coach20 = await makeCoach();
    const group20 = await makeGroupWithAthletes(coach20, 20);
    const { proxied: p20, count: c20 } = withQueryCounter(prisma);
    await buildService(p20).getGroupDashboard(coach20, group20);
    const queryCount20 = c20();

    // eslint-disable-next-line no-console
    console.log(`Query count — 1 athlète: ${queryCount1}, 5 athlètes: ${queryCount5}, 20 athlètes: ${queryCount20}`);

    expect(queryCount1).toBe(queryCount5);
    expect(queryCount5).toBe(queryCount20);
  }, 30000);
});
