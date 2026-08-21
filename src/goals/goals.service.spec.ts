import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { GoalsService } from "./goals.service";
import { GoalsRepository } from "./goals.repository";

describe("GoalsService", () => {
  let service: GoalsService;
  let repository: {
    athleteExists: jest.Mock;
    createGoal: jest.Mock;
    findAllByAthlete: jest.Mock;
    findActiveByAthlete: jest.Mock;
    goalBelongsToAthlete: jest.Mock;
    createStep: jest.Mock;
    stepBelongsToGoal: jest.Mock;
    updateStepCompleted: jest.Mock;
    updateStatus: jest.Mock;
  };

  const ATHLETE_ID = "240fe60f-6e74-46ea-87a0-45872bd1f4fe";
  const GOAL_ID = "b2e6d6b0-2a34-4f77-9e2e-2a2b2b2b2b2b";
  const STEP_ID = "c3f7e7c1-3b45-4a88-8e3f-3c3c3c3c3c3c";

  const step = (overrides: Partial<{ id: string; titre: string; ordre: number; completed: boolean; completed_at: Date | null }> = {}) => ({
    id: STEP_ID,
    titre: "Top 8 des régionaux",
    ordre: 0,
    completed: false,
    completed_at: null,
    ...overrides,
  });

  const goal = (overrides: Partial<{ statut: string; date_cible: Date | null; goal_step: ReturnType<typeof step>[] }> = {}) => ({
    id: GOAL_ID,
    type: "long_terme",
    titre: "Podium au championnat de France",
    description: null,
    date_cible: new Date("2027-03-28"),
    statut: "en_cours",
    goal_step: [],
    ...overrides,
  });

  beforeEach(async () => {
    repository = {
      athleteExists: jest.fn(),
      createGoal: jest.fn(),
      findAllByAthlete: jest.fn(),
      findActiveByAthlete: jest.fn(),
      goalBelongsToAthlete: jest.fn(),
      createStep: jest.fn(),
      stepBelongsToGoal: jest.fn(),
      updateStepCompleted: jest.fn(),
      updateStatus: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [GoalsService, { provide: GoalsRepository, useValue: repository }],
    }).compile();

    service = module.get<GoalsService>(GoalsService);
  });

  describe("createGoal", () => {
    it("crée un objectif et renvoie une vue mappée", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.createGoal.mockResolvedValue(goal());

      const result = await service.createGoal(ATHLETE_ID, {
        type: "long_terme",
        titre: "Podium au championnat de France",
        dateCible: "2027-03-28",
      });

      expect(result.titre).toBe("Podium au championnat de France");
      expect(result.progress).toEqual({ completed: 0, total: 0, percentage: null });
    });

    it("athlète inexistant -> NotFoundException (404)", async () => {
      repository.athleteExists.mockResolvedValue(false);

      await expect(
        service.createGoal(ATHLETE_ID, { titre: "Objectif" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.createGoal).not.toHaveBeenCalled();
    });
  });

  describe("addStep", () => {
    it("ajoute une étape à un objectif de l'athlète", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.goalBelongsToAthlete.mockResolvedValue(true);
      repository.createStep.mockResolvedValue(step());

      const result = await service.addStep(ATHLETE_ID, GOAL_ID, { titre: "Top 8 des régionaux" });

      expect(result.completed).toBe(false);
      expect(repository.createStep).toHaveBeenCalledWith(GOAL_ID, { titre: "Top 8 des régionaux", ordre: undefined });
    });

    it("objectif d'un autre athlète -> NotFoundException (404)", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.goalBelongsToAthlete.mockResolvedValue(false);

      await expect(
        service.addStep(ATHLETE_ID, GOAL_ID, { titre: "Top 8" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.createStep).not.toHaveBeenCalled();
    });

    it("athlète inexistant -> NotFoundException (404)", async () => {
      repository.athleteExists.mockResolvedValue(false);

      await expect(
        service.addStep(ATHLETE_ID, GOAL_ID, { titre: "Top 8" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.goalBelongsToAthlete).not.toHaveBeenCalled();
    });
  });

  describe("updateStep", () => {
    it("complétée -> completed_at renseigné", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.goalBelongsToAthlete.mockResolvedValue(true);
      repository.stepBelongsToGoal.mockResolvedValue(true);
      repository.updateStepCompleted.mockResolvedValue(step({ completed: true, completed_at: new Date() }));

      const result = await service.updateStep(ATHLETE_ID, GOAL_ID, STEP_ID, { completed: true });

      expect(result.completed).toBe(true);
      const [, completed, completedAt] = repository.updateStepCompleted.mock.calls[0];
      expect(completed).toBe(true);
      expect(completedAt).toBeInstanceOf(Date);
    });

    it("décochée -> completed_at null", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.goalBelongsToAthlete.mockResolvedValue(true);
      repository.stepBelongsToGoal.mockResolvedValue(true);
      repository.updateStepCompleted.mockResolvedValue(step({ completed: false, completed_at: null }));

      await service.updateStep(ATHLETE_ID, GOAL_ID, STEP_ID, { completed: false });

      const [, completed, completedAt] = repository.updateStepCompleted.mock.calls[0];
      expect(completed).toBe(false);
      expect(completedAt).toBeNull();
    });

    it("étape n'appartenant pas à l'objectif -> NotFoundException (404)", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.goalBelongsToAthlete.mockResolvedValue(true);
      repository.stepBelongsToGoal.mockResolvedValue(false);

      await expect(
        service.updateStep(ATHLETE_ID, GOAL_ID, STEP_ID, { completed: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.updateStepCompleted).not.toHaveBeenCalled();
    });
  });

  describe("updateStatus", () => {
    it("en_cours -> atteint : renvoie la vue objectif complète avec le nouveau statut", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.goalBelongsToAthlete.mockResolvedValue(true);
      repository.updateStatus.mockResolvedValue(goal({ statut: "atteint" }));

      const result = await service.updateStatus(ATHLETE_ID, GOAL_ID, { statut: "atteint" });

      expect(result.statut).toBe("atteint");
      expect(repository.updateStatus).toHaveBeenCalledWith(GOAL_ID, "atteint");
    });

    it("en_cours -> abandonne", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.goalBelongsToAthlete.mockResolvedValue(true);
      repository.updateStatus.mockResolvedValue(goal({ statut: "abandonne" }));

      const result = await service.updateStatus(ATHLETE_ID, GOAL_ID, { statut: "abandonne" });

      expect(result.statut).toBe("abandonne");
    });

    it("atteint -> en_cours (réactivation)", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.goalBelongsToAthlete.mockResolvedValue(true);
      repository.updateStatus.mockResolvedValue(goal({ statut: "en_cours" }));

      const result = await service.updateStatus(ATHLETE_ID, GOAL_ID, { statut: "en_cours" });

      expect(result.statut).toBe("en_cours");
    });

    it("ne modifie pas les steps ni la progression : pass-through du repository", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.goalBelongsToAthlete.mockResolvedValue(true);
      const steps = [step({ id: "s1", completed: true }), step({ id: "s2", completed: false })];
      repository.updateStatus.mockResolvedValue(goal({ statut: "atteint", goal_step: steps }));

      const result = await service.updateStatus(ATHLETE_ID, GOAL_ID, { statut: "atteint" });

      expect(result.progress).toEqual({ completed: 1, total: 2, percentage: 50 });
      expect(result.steps).toHaveLength(2);
    });

    it("objectif d'un autre athlète -> NotFoundException (404), repository jamais appelé", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.goalBelongsToAthlete.mockResolvedValue(false);

      await expect(
        service.updateStatus(ATHLETE_ID, GOAL_ID, { statut: "atteint" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.updateStatus).not.toHaveBeenCalled();
    });

    it("athlète inexistant -> NotFoundException (404)", async () => {
      repository.athleteExists.mockResolvedValue(false);

      await expect(
        service.updateStatus(ATHLETE_ID, GOAL_ID, { statut: "atteint" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.goalBelongsToAthlete).not.toHaveBeenCalled();
    });
  });

  describe("findAllForAthlete", () => {
    it("athlète sans objectif -> []", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findAllByAthlete.mockResolvedValue([]);

      await expect(service.findAllForAthlete(ATHLETE_ID)).resolves.toEqual([]);
    });

    it("place les objectifs en_cours avant les autres, en conservant l'ordre reçu au sein de chaque groupe", async () => {
      repository.athleteExists.mockResolvedValue(true);
      const abandonne = goal({ statut: "abandonne", date_cible: new Date("2026-01-01") });
      const enCoursTot = goal({ statut: "en_cours", date_cible: new Date("2026-06-01") });
      const enCoursTard = goal({ statut: "en_cours", date_cible: new Date("2026-12-01") });
      repository.findAllByAthlete.mockResolvedValue([abandonne, enCoursTot, enCoursTard]);

      const result = await service.findAllForAthlete(ATHLETE_ID);

      expect(result.map((g) => g.statut)).toEqual(["en_cours", "en_cours", "abandonne"]);
    });

    it("étapes triées par ordre (pass-through du repository)", async () => {
      repository.athleteExists.mockResolvedValue(true);
      const steps = [step({ id: "s1", ordre: 0 }), step({ id: "s2", ordre: 1 })];
      repository.findAllByAthlete.mockResolvedValue([goal({ goal_step: steps })]);

      const result = await service.findAllForAthlete(ATHLETE_ID);

      expect(result[0].steps.map((s) => s.ordre)).toEqual([0, 1]);
    });

    it("athlète inexistant -> NotFoundException (404)", async () => {
      repository.athleteExists.mockResolvedValue(false);

      await expect(service.findAllForAthlete(ATHLETE_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("findActiveForAthlete", () => {
    it("aucun objectif actif -> null", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findActiveByAthlete.mockResolvedValue(null);

      await expect(service.findActiveForAthlete(ATHLETE_ID)).resolves.toBeNull();
    });

    it("progression 1/2 = 50", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findActiveByAthlete.mockResolvedValue(
        goal({ goal_step: [step({ id: "s1", completed: true }), step({ id: "s2", completed: false })] }),
      );

      const result = await service.findActiveForAthlete(ATHLETE_ID);

      expect(result?.progress).toEqual({ completed: 1, total: 2, percentage: 50 });
    });

    it("progression 3/4 = 75", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findActiveByAthlete.mockResolvedValue(
        goal({
          goal_step: [
            step({ id: "s1", completed: true }),
            step({ id: "s2", completed: true }),
            step({ id: "s3", completed: true }),
            step({ id: "s4", completed: false }),
          ],
        }),
      );

      const result = await service.findActiveForAthlete(ATHLETE_ID);

      expect(result?.progress).toEqual({ completed: 3, total: 4, percentage: 75 });
    });

    it("aucune étape -> percentage null (pas 0)", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findActiveByAthlete.mockResolvedValue(goal({ goal_step: [] }));

      const result = await service.findActiveForAthlete(ATHLETE_ID);

      expect(result?.progress).toEqual({ completed: 0, total: 0, percentage: null });
    });

    it("athlète inexistant -> NotFoundException (404)", async () => {
      repository.athleteExists.mockResolvedValue(false);

      await expect(service.findActiveForAthlete(ATHLETE_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
