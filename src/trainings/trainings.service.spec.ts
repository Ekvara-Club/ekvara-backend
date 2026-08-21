import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { TrainingsService } from "./trainings.service";
import { TrainingsRepository } from "./trainings.repository";

describe("TrainingsService", () => {
  let service: TrainingsService;
  let repository: {
    athleteExists: jest.Mock;
    createTraining: jest.Mock;
    findAllByAthlete: jest.Mock;
    findNextByAthlete: jest.Mock;
  };

  const ATHLETE_ID = "240fe60f-6e74-46ea-87a0-45872bd1f4fe";

  const training = (
    overrides: Partial<{
      id: string;
      titre: string;
      type_seance: string | null;
      sous_type: string | null;
      date_debut: Date;
      date_fin: Date | null;
      lieu: string | null;
      niveau: string | null;
      description: string | null;
      statut: string | null;
    }> = {},
  ) => ({
    id: "training-1",
    titre: "Taekwondo au club",
    type_seance: "taekwondo",
    sous_type: "combat",
    date_debut: new Date("2026-08-20T18:30:00.000Z"),
    date_fin: new Date("2026-08-20T20:30:00.000Z"),
    lieu: "Arena Teddy Riner",
    niveau: "Elite",
    description: null,
    statut: "prevu",
    created_at: new Date(),
    updated_at: new Date(),
    athlete_id: ATHLETE_ID,
    ...overrides,
  });

  beforeEach(async () => {
    repository = {
      athleteExists: jest.fn(),
      createTraining: jest.fn(),
      findAllByAthlete: jest.fn(),
      findNextByAthlete: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [TrainingsService, { provide: TrainingsRepository, useValue: repository }],
    }).compile();

    service = module.get<TrainingsService>(TrainingsService);
  });

  describe("createTraining", () => {
    it("création valide", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.createTraining.mockResolvedValue(training());

      const result = await service.createTraining(ATHLETE_ID, {
        title: "Taekwondo au club",
        type: "taekwondo",
        subType: "combat",
        startAt: "2026-08-20T18:30:00.000Z",
        endAt: "2026-08-20T20:30:00.000Z",
        location: "Arena Teddy Riner",
        level: "Elite",
      });

      expect(result.title).toBe("Taekwondo au club");
      expect(result.status).toBe("prevu");
    });

    it("athlète inexistant -> NotFoundException (404)", async () => {
      repository.athleteExists.mockResolvedValue(false);

      await expect(
        service.createTraining(ATHLETE_ID, { title: "Séance", startAt: "2026-08-20T18:30:00.000Z" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.createTraining).not.toHaveBeenCalled();
    });

    it("date_fin antérieure à date_debut -> BadRequestException (400)", async () => {
      repository.athleteExists.mockResolvedValue(true);

      await expect(
        service.createTraining(ATHLETE_ID, {
          title: "Séance",
          startAt: "2026-08-20T18:30:00.000Z",
          endAt: "2026-08-20T17:00:00.000Z",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.createTraining).not.toHaveBeenCalled();
    });

    it("date_fin égale à date_debut -> BadRequestException (400, strictement postérieure exigée)", async () => {
      repository.athleteExists.mockResolvedValue(true);

      await expect(
        service.createTraining(ATHLETE_ID, {
          title: "Séance",
          startAt: "2026-08-20T18:30:00.000Z",
          endAt: "2026-08-20T18:30:00.000Z",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.createTraining).not.toHaveBeenCalled();
    });

    it("sans date_fin -> pas d'erreur, endAt undefined transmis au repository", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.createTraining.mockResolvedValue(training({ date_fin: null }));

      await service.createTraining(ATHLETE_ID, {
        title: "Séance",
        startAt: "2026-08-20T18:30:00.000Z",
      });

      const [, data] = repository.createTraining.mock.calls[0];
      expect(data.endAt).toBeUndefined();
    });
  });

  describe("findAllForAthlete", () => {
    it("plusieurs séances retournées, mappées en camelCase", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findAllByAthlete.mockResolvedValue([
        training({ id: "t1", date_debut: new Date("2026-08-20T00:00:00.000Z") }),
        training({ id: "t2", date_debut: new Date("2026-08-10T00:00:00.000Z") }),
      ]);

      const result = await service.findAllForAthlete(ATHLETE_ID);

      expect(result.map((t) => t.id)).toEqual(["t1", "t2"]);
      expect(result[0]).toEqual({
        id: "t1",
        title: "Taekwondo au club",
        type: "taekwondo",
        subType: "combat",
        startAt: expect.any(Date),
        endAt: expect.any(Date),
        location: "Arena Teddy Riner",
        level: "Elite",
        description: null,
        status: "prevu",
      });
    });

    it("aucune séance -> []", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findAllByAthlete.mockResolvedValue([]);

      await expect(service.findAllForAthlete(ATHLETE_ID)).resolves.toEqual([]);
    });

    it("athlète inexistant -> NotFoundException (404)", async () => {
      repository.athleteExists.mockResolvedValue(false);

      await expect(service.findAllForAthlete(ATHLETE_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("transmet la plage from/to telle quelle au repository", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findAllByAthlete.mockResolvedValue([]);
      const range = { from: new Date("2026-08-17T00:00:00.000Z"), to: new Date("2026-08-23T23:59:59.999Z") };

      await service.findAllForAthlete(ATHLETE_ID, range);

      expect(repository.findAllByAthlete).toHaveBeenCalledWith(ATHLETE_ID, range);
    });

    it("athlète inexistant avec range -> NotFoundException avant tout appel repository de plage", async () => {
      repository.athleteExists.mockResolvedValue(false);

      await expect(
        service.findAllForAthlete(ATHLETE_ID, {
          from: new Date("2026-08-17T00:00:00.000Z"),
          to: new Date("2026-08-23T23:59:59.999Z"),
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findAllByAthlete).not.toHaveBeenCalled();
    });
  });

  describe("findNextForAthlete", () => {
    it("aucune séance éligible -> null", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findNextByAthlete.mockResolvedValue(null);

      await expect(service.findNextForAthlete(ATHLETE_ID)).resolves.toBeNull();
    });

    it("séance trouvée -> vue mappée", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findNextByAthlete.mockResolvedValue(training());

      const result = await service.findNextForAthlete(ATHLETE_ID);

      expect(result?.title).toBe("Taekwondo au club");
      expect(result?.status).toBe("prevu");
    });

    it("athlète inexistant -> NotFoundException (404)", async () => {
      repository.athleteExists.mockResolvedValue(false);

      await expect(service.findNextForAthlete(ATHLETE_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
