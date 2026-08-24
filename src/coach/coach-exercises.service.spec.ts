import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { CoachExercisesService } from "./coach-exercises.service";
import { CoachExercisesRepository } from "./coach-exercises.repository";
import { CoachDestinataireResolver } from "./coach-destinataire-resolver";

describe("CoachExercisesService", () => {
  let service: CoachExercisesService;
  let repository: {
    create: jest.Mock;
    findLibraryForCoach: jest.Mock;
    findDetail: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    findCurrentAssignments: jest.Mock;
    replaceAssignments: jest.Mock;
  };
  let destinataireResolver: { resolve: jest.Mock };

  const COACH_ID = "coach-1";
  const EXERCISE_ID = "exercise-1";
  const ATHLETE_A = "athlete-a";
  const ATHLETE_B = "athlete-b";

  function detail(overrides: Record<string, unknown> = {}) {
    return {
      id: EXERCISE_ID,
      titre: "Cut avant",
      type_exercice: null,
      panel_technique: null,
      niveau: null,
      description: null,
      video_url: null,
      coach_exercise_assignment: [],
      coach_exercise_group_source: [],
      ...overrides,
    };
  }

  beforeEach(async () => {
    repository = {
      create: jest.fn(),
      findLibraryForCoach: jest.fn(),
      findDetail: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findCurrentAssignments: jest.fn(),
      replaceAssignments: jest.fn(),
    };
    destinataireResolver = { resolve: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoachExercisesService,
        { provide: CoachExercisesRepository, useValue: repository },
        { provide: CoachDestinataireResolver, useValue: destinataireResolver },
      ],
    }).compile();

    service = module.get(CoachExercisesService);
  });

  describe("createExercise", () => {
    it("crée l'exercice sans coachId dans le body (vient du paramètre), renvoie la fiche détaillée", async () => {
      repository.create.mockResolvedValue(EXERCISE_ID);
      repository.findDetail.mockResolvedValue(detail());

      const result = await service.createExercise(COACH_ID, { title: "Cut avant" });

      expect(repository.create).toHaveBeenCalledWith(COACH_ID, expect.objectContaining({ titre: "Cut avant" }));
      expect(result.id).toBe(EXERCISE_ID);
    });
  });

  describe("findOneForCoach", () => {
    it("exercice introuvable -> NotFoundException", async () => {
      repository.findDetail.mockResolvedValue(null);
      await expect(service.findOneForCoach(EXERCISE_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("mappe assignments.athleteCount / athletes / groups correctement", async () => {
      repository.findDetail.mockResolvedValue(
        detail({
          coach_exercise_assignment: [{ athlete: { id: ATHLETE_A, app_user: { prenom: "Kais", nom: "Ali" } } }],
          coach_exercise_group_source: [{ coach_group: { id: "g-1", name: "Élite" } }],
        }),
      );

      const result = await service.findOneForCoach(EXERCISE_ID);

      expect(result.assignments).toEqual({
        athleteCount: 1,
        athletes: [{ id: ATHLETE_A, firstName: "Kais", lastName: "Ali" }],
        groups: [{ id: "g-1", name: "Élite" }],
      });
    });
  });

  describe("updateContent", () => {
    it("aucun champ fourni -> BadRequestException", async () => {
      await expect(service.updateContent(EXERCISE_ID, {})).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it("modification valide -> propage uniquement les champs fournis, une seule ligne mise à jour (pas de batch)", async () => {
      repository.findDetail.mockResolvedValue(detail({ titre: "Nouveau titre" }));

      await service.updateContent(EXERCISE_ID, { title: "Nouveau titre" });

      expect(repository.update).toHaveBeenCalledWith(EXERCISE_ID, { titre: "Nouveau titre" });
    });
  });

  describe("deleteExercise", () => {
    it("délègue à repository.delete", async () => {
      await service.deleteExercise(EXERCISE_ID);
      expect(repository.delete).toHaveBeenCalledWith(EXERCISE_ID);
    });
  });

  describe("replaceAssignments — diff add/remove", () => {
    it("calcule toAdd/toRemove à partir des assignments courants", async () => {
      destinataireResolver.resolve.mockResolvedValue({ athleteIds: ["athlete-c"], groupIds: [] });
      repository.findCurrentAssignments.mockResolvedValue([{ athlete_id: ATHLETE_A }, { athlete_id: ATHLETE_B }]);
      repository.findDetail.mockResolvedValue(detail());

      await service.replaceAssignments(COACH_ID, EXERCISE_ID, { groupIds: [], athleteIds: ["athlete-c"] });

      const [, toAdd, toRemove] = repository.replaceAssignments.mock.calls[0];
      expect(toAdd).toEqual(["athlete-c"]);
      expect(toRemove.sort()).toEqual([ATHLETE_A, ATHLETE_B].sort());
    });

    it("destinataire non autorisé -> l'exception du resolver remonte, aucun appel repository.replaceAssignments", async () => {
      destinataireResolver.resolve.mockRejectedValue(new ForbiddenException("non autorisé"));

      await expect(
        service.replaceAssignments(COACH_ID, EXERCISE_ID, { groupIds: [], athleteIds: [ATHLETE_A] }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.replaceAssignments).not.toHaveBeenCalled();
    });
  });

  describe("findLibraryForCoach", () => {
    it("mappe athleteCount et groups", async () => {
      repository.findLibraryForCoach.mockResolvedValue([
        {
          id: EXERCISE_ID,
          titre: "Cut avant",
          type_exercice: null,
          panel_technique: null,
          niveau: null,
          description: null,
          video_url: null,
          _count: { coach_exercise_assignment: 2 },
          coach_exercise_group_source: [{ coach_group: { id: "g-1", name: "Élite" } }],
        },
      ]);

      const result = await service.findLibraryForCoach(COACH_ID);

      expect(result[0].athleteCount).toBe(2);
      expect(result[0].groups).toEqual([{ id: "g-1", name: "Élite" }]);
    });

    it("coach sans exercice -> []", async () => {
      repository.findLibraryForCoach.mockResolvedValue([]);
      expect(await service.findLibraryForCoach(COACH_ID)).toEqual([]);
    });
  });
});
