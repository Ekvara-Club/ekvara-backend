import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { WeightsService } from "./weights.service";
import { WeightsRepository } from "./weights.repository";
import { CompetitionsRepository } from "../competitions/competitions.repository";
import { Prisma } from "../../generated/prisma/client";

describe("WeightsService", () => {
  let service: WeightsService;
  let weightsRepository: {
    athleteExists: jest.Mock;
    createWeightLog: jest.Mock;
    findWeightLogsByAthlete: jest.Mock;
    findLatestWeightLog: jest.Mock;
    findReferenceWeightLog: jest.Mock;
    findActiveWeightTarget: jest.Mock;
    replaceActiveWeightTarget: jest.Mock;
  };
  let competitionsRepository: { findById: jest.Mock };

  const ATHLETE_ID = "240fe60f-6e74-46ea-87a0-45872bd1f4fe";
  const COMPETITION_ID = "d337932f-359b-4f5b-bab7-84a6f7cb8c94";

  const weightLog = (kg: number, dateMesure: Date, note: string | null = null) => ({
    id: `log-${kg}-${dateMesure.getTime()}`,
    athlete_id: ATHLETE_ID,
    valeur_kg: new Prisma.Decimal(kg),
    date_mesure: dateMesure,
    note,
    created_at: dateMesure,
  });

  const weightTarget = (kg: number, competitionId: string | null = null) => ({
    id: "target-1",
    athlete_id: ATHLETE_ID,
    competition_id: competitionId,
    poids_cible_kg: new Prisma.Decimal(kg),
    date_cible: new Date(Date.UTC(2026, 8, 25)),
    actif: true,
    created_at: new Date(),
    updated_at: new Date(),
  });

  beforeEach(async () => {
    weightsRepository = {
      athleteExists: jest.fn(),
      createWeightLog: jest.fn(),
      findWeightLogsByAthlete: jest.fn(),
      findLatestWeightLog: jest.fn(),
      findReferenceWeightLog: jest.fn(),
      findActiveWeightTarget: jest.fn(),
      replaceActiveWeightTarget: jest.fn(),
    };
    competitionsRepository = { findById: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeightsService,
        { provide: WeightsRepository, useValue: weightsRepository },
        { provide: CompetitionsRepository, useValue: competitionsRepository },
      ],
    }).compile();

    service = module.get<WeightsService>(WeightsService);
  });

  describe("createWeightLog", () => {
    it("crée une pesée avec la date fournie et renvoie une vue mappée", async () => {
      weightsRepository.athleteExists.mockResolvedValue(true);
      const measuredAt = new Date("2026-08-15T14:55:00.000Z");
      weightsRepository.createWeightLog.mockResolvedValue(weightLog(74.5, measuredAt, "Après le déjeuner"));

      const result = await service.createWeightLog(ATHLETE_ID, {
        weight: 74.5,
        measuredAt: "2026-08-15T14:55:00.000Z",
        note: "Après le déjeuner",
      });

      expect(result).toEqual({
        id: expect.any(String),
        weight: 74.5,
        measuredAt,
        note: "Après le déjeuner",
      });
      expect(weightsRepository.createWeightLog).toHaveBeenCalledWith(
        ATHLETE_ID,
        expect.objectContaining({ weight: 74.5, measuredAt }),
      );
    });

    it("utilise l'heure courante quand measuredAt est absent", async () => {
      weightsRepository.athleteExists.mockResolvedValue(true);
      weightsRepository.createWeightLog.mockResolvedValue(weightLog(74.5, new Date()));

      await service.createWeightLog(ATHLETE_ID, { weight: 74.5 });

      const [, data] = weightsRepository.createWeightLog.mock.calls[0];
      expect(data.measuredAt).toBeInstanceOf(Date);
      expect(Date.now() - data.measuredAt.getTime()).toBeLessThan(5000);
    });

    it("athlète inexistant -> NotFoundException (404)", async () => {
      weightsRepository.athleteExists.mockResolvedValue(false);

      await expect(service.createWeightLog(ATHLETE_ID, { weight: 74.5 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(weightsRepository.createWeightLog).not.toHaveBeenCalled();
    });
  });

  describe("findWeightLogsForAthlete", () => {
    it("retourne l'historique mappé (weight en nombre, pas Decimal)", async () => {
      weightsRepository.athleteExists.mockResolvedValue(true);
      weightsRepository.findWeightLogsByAthlete.mockResolvedValue([
        weightLog(74.5, new Date("2026-08-15T00:00:00.000Z")),
        weightLog(74.8, new Date("2026-08-08T00:00:00.000Z")),
      ]);

      const result = await service.findWeightLogsForAthlete(ATHLETE_ID);

      expect(result).toEqual([
        { id: expect.any(String), weight: 74.5, measuredAt: new Date("2026-08-15T00:00:00.000Z"), note: null },
        { id: expect.any(String), weight: 74.8, measuredAt: new Date("2026-08-08T00:00:00.000Z"), note: null },
      ]);
    });

    it("athlète sans pesée -> []", async () => {
      weightsRepository.athleteExists.mockResolvedValue(true);
      weightsRepository.findWeightLogsByAthlete.mockResolvedValue([]);

      await expect(service.findWeightLogsForAthlete(ATHLETE_ID)).resolves.toEqual([]);
    });

    it("athlète inexistant -> NotFoundException (404)", async () => {
      weightsRepository.athleteExists.mockResolvedValue(false);

      await expect(service.findWeightLogsForAthlete(ATHLETE_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("createWeightTarget", () => {
    it("crée un objectif sans compétition liée", async () => {
      weightsRepository.athleteExists.mockResolvedValue(true);
      weightsRepository.replaceActiveWeightTarget.mockResolvedValue(weightTarget(74.0));

      const result = await service.createWeightTarget(ATHLETE_ID, { weight: 74.0 });

      expect(result.weight).toBe(74.0);
      expect(competitionsRepository.findById).not.toHaveBeenCalled();
    });

    it("crée un objectif lié à une compétition existante", async () => {
      weightsRepository.athleteExists.mockResolvedValue(true);
      competitionsRepository.findById.mockResolvedValue({ id: COMPETITION_ID });
      weightsRepository.replaceActiveWeightTarget.mockResolvedValue(
        weightTarget(74.0, COMPETITION_ID),
      );

      const result = await service.createWeightTarget(ATHLETE_ID, {
        weight: 74.0,
        competitionId: COMPETITION_ID,
      });

      expect(result.competitionId).toBe(COMPETITION_ID);
      expect(weightsRepository.replaceActiveWeightTarget).toHaveBeenCalledWith(
        ATHLETE_ID,
        expect.objectContaining({ competitionId: COMPETITION_ID }),
      );
    });

    it("compétition cible inconnue -> NotFoundException (404)", async () => {
      weightsRepository.athleteExists.mockResolvedValue(true);
      competitionsRepository.findById.mockResolvedValue(null);

      await expect(
        service.createWeightTarget(ATHLETE_ID, { weight: 74.0, competitionId: COMPETITION_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(weightsRepository.replaceActiveWeightTarget).not.toHaveBeenCalled();
    });

    it("athlète inexistant -> NotFoundException (404)", async () => {
      weightsRepository.athleteExists.mockResolvedValue(false);

      await expect(service.createWeightTarget(ATHLETE_ID, { weight: 74.0 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("getWeightSummary", () => {
    it("athlète sans aucune donnée -> résumé entièrement null (pas de 404)", async () => {
      weightsRepository.athleteExists.mockResolvedValue(true);
      weightsRepository.findLatestWeightLog.mockResolvedValue(null);
      weightsRepository.findActiveWeightTarget.mockResolvedValue(null);

      const result = await service.getWeightSummary(ATHLETE_ID);

      expect(result).toEqual({
        currentWeight: null,
        measuredAt: null,
        target: null,
        differenceToTarget: null,
        weeklyChange: null,
      });
      expect(weightsRepository.findReferenceWeightLog).not.toHaveBeenCalled();
    });

    it("objectif sans aucune pesée : l'objectif est renvoyé, le reste reste null", async () => {
      weightsRepository.athleteExists.mockResolvedValue(true);
      weightsRepository.findLatestWeightLog.mockResolvedValue(null);
      weightsRepository.findActiveWeightTarget.mockResolvedValue(weightTarget(74.0, COMPETITION_ID));

      const result = await service.getWeightSummary(ATHLETE_ID);

      expect(result.target).toEqual({
        weight: 74.0,
        targetDate: expect.any(Date),
        competitionId: COMPETITION_ID,
      });
      expect(result.currentWeight).toBeNull();
      expect(result.measuredAt).toBeNull();
      expect(result.differenceToTarget).toBeNull();
      expect(result.weeklyChange).toBeNull();
    });

    it("differenceToTarget positive quand le poids actuel dépasse la cible (74.5 vs 74.0 -> 0.5)", async () => {
      weightsRepository.athleteExists.mockResolvedValue(true);
      weightsRepository.findLatestWeightLog.mockResolvedValue(weightLog(74.5, new Date()));
      weightsRepository.findActiveWeightTarget.mockResolvedValue(weightTarget(74.0));
      weightsRepository.findReferenceWeightLog.mockResolvedValue(null);

      const result = await service.getWeightSummary(ATHLETE_ID);

      expect(result.differenceToTarget).toBe(0.5);
    });

    it("differenceToTarget négative quand le poids actuel est sous la cible (73.5 vs 74.0 -> -0.5)", async () => {
      weightsRepository.athleteExists.mockResolvedValue(true);
      weightsRepository.findLatestWeightLog.mockResolvedValue(weightLog(73.5, new Date()));
      weightsRepository.findActiveWeightTarget.mockResolvedValue(weightTarget(74.0));
      weightsRepository.findReferenceWeightLog.mockResolvedValue(null);

      const result = await service.getWeightSummary(ATHLETE_ID);

      expect(result.differenceToTarget).toBe(-0.5);
    });

    it("objectif atteint : différence à 0, sans transformation en valeur absolue trompeuse", async () => {
      weightsRepository.athleteExists.mockResolvedValue(true);
      weightsRepository.findLatestWeightLog.mockResolvedValue(weightLog(74.0, new Date()));
      weightsRepository.findActiveWeightTarget.mockResolvedValue(weightTarget(74.0));
      weightsRepository.findReferenceWeightLog.mockResolvedValue(null);

      const result = await service.getWeightSummary(ATHLETE_ID);

      expect(result.differenceToTarget).toBe(0);
    });

    it("weeklyChange négatif (74.8 il y a une semaine -> 74.5 aujourd'hui = -0.3)", async () => {
      const now = new Date("2026-08-15T00:00:00.000Z");
      const weekAgo = new Date("2026-08-08T00:00:00.000Z");
      weightsRepository.athleteExists.mockResolvedValue(true);
      weightsRepository.findLatestWeightLog.mockResolvedValue(weightLog(74.5, now));
      weightsRepository.findActiveWeightTarget.mockResolvedValue(null);
      weightsRepository.findReferenceWeightLog.mockResolvedValue(weightLog(74.8, weekAgo));

      const result = await service.getWeightSummary(ATHLETE_ID);

      expect(result.weeklyChange).toBe(-0.3);
    });

    it("weeklyChange positif (74.2 il y a une semaine -> 74.5 aujourd'hui = +0.3)", async () => {
      const now = new Date("2026-08-15T00:00:00.000Z");
      const weekAgo = new Date("2026-08-08T00:00:00.000Z");
      weightsRepository.athleteExists.mockResolvedValue(true);
      weightsRepository.findLatestWeightLog.mockResolvedValue(weightLog(74.5, now));
      weightsRepository.findActiveWeightTarget.mockResolvedValue(null);
      weightsRepository.findReferenceWeightLog.mockResolvedValue(weightLog(74.2, weekAgo));

      const result = await service.getWeightSummary(ATHLETE_ID);

      expect(result.weeklyChange).toBe(0.3);
    });

    it("aucune mesure vieille d'au moins 7 jours -> weeklyChange null", async () => {
      const now = new Date("2026-08-15T00:00:00.000Z");
      weightsRepository.athleteExists.mockResolvedValue(true);
      weightsRepository.findLatestWeightLog.mockResolvedValue(weightLog(74.5, now));
      weightsRepository.findActiveWeightTarget.mockResolvedValue(null);
      weightsRepository.findReferenceWeightLog.mockResolvedValue(null);

      const result = await service.getWeightSummary(ATHLETE_ID);

      expect(result.weeklyChange).toBeNull();
    });

    it("interroge la référence avec un seuil exact de 7 jours avant la mesure actuelle", async () => {
      const now = new Date("2026-08-15T12:00:00.000Z");
      weightsRepository.athleteExists.mockResolvedValue(true);
      weightsRepository.findLatestWeightLog.mockResolvedValue(weightLog(74.5, now));
      weightsRepository.findActiveWeightTarget.mockResolvedValue(null);
      weightsRepository.findReferenceWeightLog.mockResolvedValue(null);

      await service.getWeightSummary(ATHLETE_ID);

      const [, cutoff] = weightsRepository.findReferenceWeightLog.mock.calls[0];
      expect(cutoff.getTime()).toBe(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    });

    it("athlète inexistant -> NotFoundException (404)", async () => {
      weightsRepository.athleteExists.mockResolvedValue(false);

      await expect(service.getWeightSummary(ATHLETE_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
