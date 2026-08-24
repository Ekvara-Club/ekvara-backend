import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { WeightsService } from "../weights/weights.service";
import { WeightsRepository } from "../weights/weights.repository";
import { CompetitionsRepository } from "../competitions/competitions.repository";
import { GoalsService } from "../goals/goals.service";
import { GoalsRepository } from "../goals/goals.repository";
import { CoachRepository } from "./coach.repository";
import { CoachGroupsRepository } from "./coach-groups.repository";
import { CoachDashboardRepository } from "./coach-dashboard.repository";
import { CoachDashboardService } from "./coach-dashboard.service";
import { MetricsRepository } from "../metrics/metrics.repository";

// Deux garanties critiques du ticket "Pilotage individuel Coach", chacune
// contre la vraie base Postgres locale, avec les VRAIS services :
//
// §28 — une donnée créée/modifiée par le coach doit apparaître IMMÉDIATEMENT
// via les VRAIS endpoints athlete existants (WeightsService.getWeightSummary,
// GoalsService.findAllForAthlete/findActiveForAthlete), sans aucun chemin
// coach-aware — même principe que coach-training-athlete-planning.spec.ts
// (ticket #3) et coach-exercise-athlete-visibility.spec.ts (ticket #4).
//
// §29 — le dashboard coach (ticket #2, non modifié dans ce ticket) doit
// refléter la nouvelle donnée sans aucune logique spéciale : ses batch
// queries lisent directement weight_target/athlete_goal, donc une écriture
// coach y apparaît par construction — vérifié ici, pas supposé.
describe("Pilotage individuel coach — réaction athlete-facing et dashboard (intégration Postgres)", () => {
  let prisma: PrismaService;
  let weightsService: WeightsService;
  let goalsService: GoalsService;
  let dashboardService: CoachDashboardService;
  const runId = Date.now();
  const createdUserIds: string[] = [];
  let counter = 0;

  beforeAll(() => {
    prisma = new PrismaService();
    weightsService = new WeightsService(new WeightsRepository(prisma), new CompetitionsRepository(prisma));
    goalsService = new GoalsService(new GoalsRepository(prisma));
    dashboardService = new CoachDashboardService(
      new CoachRepository(prisma),
      new CoachGroupsRepository(prisma),
      new CoachDashboardRepository(prisma, new MetricsRepository(prisma)),
    );
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
      data: { email: `test-fixture-down-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `F${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return profile.id;
  }

  async function makeAthlete(prenom: string): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-down-athlete-${runId}-${counter}@test.fr`, nom: "Test", prenom },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
    return athlete.id;
  }

  describe("§28 — vrais endpoints athlete", () => {
    it("target créé par le coach -> visible via le VRAI getWeightSummary (équivalent GET /athletes/:id/weight-summary)", async () => {
      const athleteA = await makeAthlete("A");

      await weightsService.createWeightTarget(athleteA, { weight: 74 });

      const summary = await weightsService.getWeightSummary(athleteA);
      expect(summary.target?.weight).toBe(74);
    });

    it("goal créé par le coach -> visible via le VRAI findAllForAthlete (équivalent GET /athletes/:id/goals)", async () => {
      const athleteA = await makeAthlete("A");

      const goal = await goalsService.createGoal(athleteA, { titre: `Objectif coach ${runId}` });

      const goals = await goalsService.findAllForAthlete(athleteA);
      expect(goals.map((g) => g.id)).toContain(goal.id);
    });

    it("goal créé par le coach -> visible en 'actif' via findActiveForAthlete (équivalent GET /athletes/:id/goals/active)", async () => {
      const athleteA = await makeAthlete("A");
      const goal = await goalsService.createGoal(athleteA, { titre: `Objectif actif coach ${runId}` });

      const active = await goalsService.findActiveForAthlete(athleteA);
      expect(active?.id).toBe(goal.id);
    });

    it("coach marque l'objectif 'atteint' -> findActiveForAthlete réagit exactement comme aujourd'hui (n'est plus actif)", async () => {
      const athleteA = await makeAthlete("A");
      const goal = await goalsService.createGoal(athleteA, { titre: `Objectif à terminer ${runId}` });
      expect((await goalsService.findActiveForAthlete(athleteA))?.id).toBe(goal.id);

      await goalsService.updateStatus(athleteA, goal.id, { statut: "atteint" });

      expect(await goalsService.findActiveForAthlete(athleteA)).toBeNull();
    });

    it("coach ajoute/coche une étape -> le progress lu par l'athlète change immédiatement", async () => {
      const athleteA = await makeAthlete("A");
      const goal = await goalsService.createGoal(athleteA, { titre: `Objectif progress ${runId}` });
      const step = await goalsService.addStep(athleteA, goal.id, { titre: "Étape unique" });

      await goalsService.updateStep(athleteA, goal.id, step.id, { completed: true });

      const [goalAfter] = await goalsService.findAllForAthlete(athleteA);
      expect(goalAfter.progress).toEqual({ completed: 1, total: 1, percentage: 100 });
    });
  });

  describe("§29 — dashboard coach", () => {
    it("target modifié par le coach -> immédiatement reflété dans GET /coach/athletes/:id/dashboard (weight)", async () => {
      const coachId = await makeCoach();
      const athleteA = await makeAthlete("A");
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteA } });
      await prisma.weight_log.create({ data: { athlete_id: athleteA, valeur_kg: 75, date_mesure: new Date() } });

      await weightsService.createWeightTarget(athleteA, { weight: 74 });

      const athleteDashboard = await dashboardService.getAthleteDashboard(coachId, athleteA);
      expect(athleteDashboard.weight.target?.weight).toBe(74);
      expect(athleteDashboard.weight.differenceToTarget).toBe(1);

      const globalDashboard = await dashboardService.getDashboard(coachId);
      expect(globalDashboard.summary.athletesAboveTargetWeight).toBe(1);
    });

    it("goal modifié par le coach -> immédiatement reflété dans primaryGoal du dashboard", async () => {
      const coachId = await makeCoach();
      const athleteA = await makeAthlete("A");
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteA } });

      const goal = await goalsService.createGoal(athleteA, { titre: `Objectif dashboard ${runId}`, dateCible: "2026-12-01" });

      const before = await dashboardService.getAthleteDashboard(coachId, athleteA);
      expect(before.primaryGoal?.id).toBe(goal.id);

      await goalsService.addStep(athleteA, goal.id, { titre: "Étape" });
      const step = (await goalsService.findAllForAthlete(athleteA))[0].steps[0];
      await goalsService.updateStep(athleteA, goal.id, step.id, { completed: true });

      const after = await dashboardService.getAthleteDashboard(coachId, athleteA);
      expect(after.primaryGoal?.progressPercentage).toBe(100);
    });
  });
});
