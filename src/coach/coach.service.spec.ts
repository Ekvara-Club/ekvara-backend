import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { CoachService } from "./coach.service";
import { CoachRepository } from "./coach.repository";

describe("CoachService", () => {
  let service: CoachService;
  let repository: {
    findProfileById: jest.Mock;
    coachAthleteExists: jest.Mock;
    removeCoachAthlete: jest.Mock;
    findAthletesForCoach: jest.Mock;
  };

  const COACH_ID = "coach-1";
  const ATHLETE_ID = "athlete-1";

  beforeEach(async () => {
    repository = {
      findProfileById: jest.fn(),
      coachAthleteExists: jest.fn(),
      removeCoachAthlete: jest.fn(),
      findAthletesForCoach: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CoachService, { provide: CoachRepository, useValue: repository }],
    }).compile();

    service = module.get(CoachService);
  });

  describe("getMe", () => {
    it("mappe le profil vers user{} / club{} sans jamais exposer password_hash", async () => {
      repository.findProfileById.mockResolvedValue({
        id: COACH_ID,
        app_user: { id: "u-1", email: "coach@test.fr", nom: "Dupont", prenom: "Jean" },
        club: { id: "club-1", nom: "TKD Paris", pays: "France", ville: "Paris" },
      });

      const result = await service.getMe(COACH_ID);

      expect(result).toEqual({
        id: COACH_ID,
        user: { id: "u-1", prenom: "Jean", nom: "Dupont", email: "coach@test.fr" },
        club: { id: "club-1", nom: "TKD Paris", pays: "France", ville: "Paris" },
      });
      expect(JSON.stringify(result)).not.toMatch(/password/i);
    });

    it("club null accepté", async () => {
      repository.findProfileById.mockResolvedValue({
        id: COACH_ID,
        app_user: { id: "u-1", email: "coach@test.fr", nom: null, prenom: null },
        club: null,
      });

      const result = await service.getMe(COACH_ID);
      expect(result.club).toBeNull();
    });

    it("profil introuvable -> NotFoundException", async () => {
      repository.findProfileById.mockResolvedValue(null);
      await expect(service.getMe(COACH_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("removeAthlete", () => {
    it("délègue à CoachRepository.removeCoachAthlete (logique transactionnelle testée en intégration Postgres)", async () => {
      repository.removeCoachAthlete.mockResolvedValue(undefined);

      const result = await service.removeAthlete(COACH_ID, ATHLETE_ID);

      expect(result).toBeUndefined();
      expect(repository.removeCoachAthlete).toHaveBeenCalledWith(COACH_ID, ATHLETE_ID);
    });
  });

  describe("listAthletes", () => {
    it("liste vide -> []", async () => {
      repository.findAthletesForCoach.mockResolvedValue([]);
      const result = await service.listAthletes(COACH_ID);
      expect(result).toEqual([]);
    });

    it("trie par nom puis prénom, mappe categoriePoids à null (pas de colonne équivalente sur athlete)", async () => {
      repository.findAthletesForCoach.mockResolvedValue([
        {
          athlete: {
            id: "a-2",
            categorie_age: "senior",
            grade: "2e dan",
            niveau_sportif: "national",
            app_user: { nom: "Zidane", prenom: "Adam" },
          },
        },
        {
          athlete: {
            id: "a-1",
            categorie_age: "junior",
            grade: "1er dan",
            niveau_sportif: "regional",
            app_user: { nom: "Ali", prenom: "Kais" },
          },
        },
      ]);

      const result = await service.listAthletes(COACH_ID);

      expect(result.map((a: { id: string }) => a.id)).toEqual(["a-1", "a-2"]);
      expect(result[0]).toEqual({
        id: "a-1",
        prenom: "Kais",
        nom: "Ali",
        categorieAge: "junior",
        categoriePoids: null,
        grade: "1er dan",
        niveauSportif: "regional",
      });
    });
  });
});
