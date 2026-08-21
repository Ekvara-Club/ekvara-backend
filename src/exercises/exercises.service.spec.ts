import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { ExercisesService } from "./exercises.service";
import { ExercisesRepository } from "./exercises.repository";

describe("ExercisesService", () => {
  let service: ExercisesService;
  let repository: {
    findMany: jest.Mock;
    findById: jest.Mock;
  };

  const EXERCISE_ID = "240fe60f-6e74-46ea-87a0-45872bd1f4fe";

  const exercise = (overrides: Partial<{ titre: string }> = {}) => ({
    id: EXERCISE_ID,
    titre: "Travail du cut en déplacement",
    type_exercice: "technique",
    panel_technique: "cut",
    niveau: "intermediaire",
    description: "Description",
    video_url: null,
    gratuit: true,
    ...overrides,
  });

  beforeEach(async () => {
    repository = {
      findMany: jest.fn(),
      findById: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [ExercisesService, { provide: ExercisesRepository, useValue: repository }],
    }).compile();

    service = moduleRef.get(ExercisesService);
  });

  it("findAll délègue au repository et retourne la liste telle quelle", async () => {
    repository.findMany.mockResolvedValue([exercise()]);

    const result = await service.findAll();

    expect(repository.findMany).toHaveBeenCalled();
    expect(result).toEqual([exercise()]);
  });

  it("findAll retourne une liste vide quand aucun exercice n'existe", async () => {
    repository.findMany.mockResolvedValue([]);

    const result = await service.findAll();

    expect(result).toEqual([]);
  });

  it("findOne retourne l'exercice quand il existe", async () => {
    repository.findById.mockResolvedValue(exercise());

    const result = await service.findOne(EXERCISE_ID);

    expect(repository.findById).toHaveBeenCalledWith(EXERCISE_ID);
    expect(result).toEqual(exercise());
  });

  it("findOne lève NotFoundException quand l'exercice est absent", async () => {
    repository.findById.mockResolvedValue(null);

    await expect(service.findOne(EXERCISE_ID)).rejects.toThrow(NotFoundException);
  });
});
