import "dotenv/config";
import { NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { WeightsService } from "../weights/weights.service";
import { WeightsRepository } from "../weights/weights.repository";
import { CompetitionsRepository } from "../competitions/competitions.repository";
import { GoalsService } from "../goals/goals.service";
import { GoalsRepository } from "../goals/goals.repository";

// Test d'intégration contre la vraie base Postgres locale (ticket "Pilotage
// individuel Coach" §27) : fixtures coach A + athlete A (lié) + athlete B
// (non lié) + athlete C (lié). Utilise directement WeightsService/
// GoalsService — les VRAIS services athlete-facing, exactement comme les
// contrôleurs coach le font (aucune couche coach parallèle à tester en plus,
// voir ticket §4). Fixtures jetables nettoyées en afterEach via cascade sur
// app_user.
describe("Pilotage individuel coach — weight_target / athlete_goal (intégration Postgres)", () => {
  let prisma: PrismaService;
  let weightsService: WeightsService;
  let goalsService: GoalsService;
  const runId = Date.now();
  const createdUserIds: string[] = [];
  let counter = 0;

  beforeAll(() => {
    prisma = new PrismaService();
    weightsService = new WeightsService(new WeightsRepository(prisma), new CompetitionsRepository(prisma));
    goalsService = new GoalsService(new GoalsRepository(prisma));
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
      data: { email: `test-fixture-pilot-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `F${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return profile.id;
  }

  async function makeAthlete(prenom: string): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-pilot-athlete-${runId}-${counter}@test.fr`, nom: "Test", prenom },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
    return athlete.id;
  }

  describe("weight_target", () => {
    it("aucun target -> créer -> remplacer : l'ancien devient inactif, le nouveau actif (même transaction que l'app athlète)", async () => {
      const athleteA = await makeAthlete("A");

      const before = await weightsService.getWeightSummary(athleteA);
      expect(before.target).toBeNull();

      const first = await weightsService.createWeightTarget(athleteA, { weight: 75 });
      expect(first.actif).toBe(true);

      const second = await weightsService.createWeightTarget(athleteA, { weight: 74 });
      expect(second.actif).toBe(true);

      const activeTargets = await prisma.weight_target.findMany({ where: { athlete_id: athleteA, actif: true } });
      expect(activeTargets).toHaveLength(1);
      expect(activeTargets[0].poids_cible_kg.toNumber()).toBe(74);

      const allTargets = await prisma.weight_target.findMany({ where: { athlete_id: athleteA } });
      expect(allTargets).toHaveLength(2);
      expect(allTargets.find((t) => t.id !== activeTargets[0].id)?.actif).toBe(false);
    });

    it("retrait coach_athlete : le target créé par le coach reste intact et actif", async () => {
      const coachId = await makeCoach();
      const athleteA = await makeAthlete("A");
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteA } });

      await weightsService.createWeightTarget(athleteA, { weight: 74 });
      await prisma.coach_athlete.delete({ where: { coach_id_athlete_id: { coach_id: coachId, athlete_id: athleteA } } });

      const summary = await weightsService.getWeightSummary(athleteA);
      expect(summary.target?.weight).toBe(74);
    });

    it("competitionId inconnu -> NotFoundException contrôlée (même règle que l'athlète, aucune vérification de participation)", async () => {
      const athleteA = await makeAthlete("A");
      await expect(
        weightsService.createWeightTarget(athleteA, { weight: 74, competitionId: "00000000-0000-4000-8000-000000000000" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("athlete_goal / goal_step", () => {
    it("create -> status -> add step -> toggle : cycle complet via les mêmes services que l'athlète", async () => {
      const athleteA = await makeAthlete("A");

      const goal = await goalsService.createGoal(athleteA, { titre: `Médaille régionale ${runId}` });
      expect(goal.statut).toBe("en_cours");

      const step = await goalsService.addStep(athleteA, goal.id, { titre: "Entraînement renforcé" });
      expect(step.completed).toBe(false);

      const toggled = await goalsService.updateStep(athleteA, goal.id, step.id, { completed: true });
      expect(toggled.completed).toBe(true);

      const updated = await goalsService.updateStatus(athleteA, goal.id, { statut: "atteint" });
      expect(updated.statut).toBe("atteint");
      expect(updated.progress).toEqual({ completed: 1, total: 1, percentage: 100 });
    });

    it("goal cross-athlete : goal de B via l'URL/paramètre athleteId de A -> refusé (même si le coach gère aussi B)", async () => {
      const coachId = await makeCoach();
      const athleteA = await makeAthlete("A");
      const athleteB = await makeAthlete("B");
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteA } });
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteB } });

      const goalOfB = await goalsService.createGoal(athleteB, { titre: `Objectif de B ${runId}` });

      // Le coach gère A ET B, mais appelle la route de A avec le goalId de B.
      await expect(goalsService.updateStatus(athleteA, goalOfB.id, { statut: "atteint" })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("step cross-goal : step d'un autre goal du MÊME athlète -> refusé", async () => {
      const athleteA = await makeAthlete("A");
      const goal1 = await goalsService.createGoal(athleteA, { titre: `Goal 1 ${runId}` });
      const goal2 = await goalsService.createGoal(athleteA, { titre: `Goal 2 ${runId}` });
      const stepOfGoal2 = await goalsService.addStep(athleteA, goal2.id, { titre: "Étape de goal 2" });

      await expect(
        goalsService.updateStep(athleteA, goal1.id, stepOfGoal2.id, { completed: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("retrait coach_athlete : le goal créé par le coach reste intact et modifiable par l'athlète lui-même", async () => {
      const coachId = await makeCoach();
      const athleteA = await makeAthlete("A");
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteA } });

      const goal = await goalsService.createGoal(athleteA, { titre: `Objectif persistant ${runId}` });
      await prisma.coach_athlete.delete({ where: { coach_id_athlete_id: { coach_id: coachId, athlete_id: athleteA } } });

      const goals = await goalsService.findAllForAthlete(athleteA);
      expect(goals.map((g) => g.id)).toContain(goal.id);
      // L'athlète (via son propre flux, inchangé) peut toujours le modifier :
      const updated = await goalsService.updateStatus(athleteA, goal.id, { statut: "abandonne" });
      expect(updated.statut).toBe("abandonne");
    });
  });
});
