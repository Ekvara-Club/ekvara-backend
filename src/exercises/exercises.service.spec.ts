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

  const ATHLETE_ID = "a1a1a1a1-0000-4000-8000-000000000001";

  it("findAll transmet athleteId au repository et retourne la liste telle quelle", async () => {
    repository.findMany.mockResolvedValue([exercise()]);

    const result = await service.findAll(ATHLETE_ID);

    expect(repository.findMany).toHaveBeenCalledWith(ATHLETE_ID);
    expect(result).toEqual([exercise()]);
  });

  it("findAll sans athleteId (coach-only) -> transmet undefined, ne plante pas", async () => {
    repository.findMany.mockResolvedValue([]);

    const result = await service.findAll(undefined);

    expect(repository.findMany).toHaveBeenCalledWith(undefined);
    expect(result).toEqual([]);
  });

  it("findOne transmet id ET athleteId au repository", async () => {
    repository.findById.mockResolvedValue(exercise());

    const result = await service.findOne(EXERCISE_ID, ATHLETE_ID);

    expect(repository.findById).toHaveBeenCalledWith(EXERCISE_ID, ATHLETE_ID);
    expect(result).toEqual(exercise());
  });

  it("findOne lève NotFoundException quand l'exercice est absent OU non visible pour cet athlète (même exception, jamais de distinction qui confirmerait son existence)", async () => {
    repository.findById.mockResolvedValue(null);

    await expect(service.findOne(EXERCISE_ID, ATHLETE_ID)).rejects.toThrow(NotFoundException);
  });
});
