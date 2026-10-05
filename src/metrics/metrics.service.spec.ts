import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { compareMeasurements, computePercentage, MetricsService } from "./metrics.service";
import { MetricsRepository } from "./metrics.repository";
import { Prisma } from "../../generated/prisma/client";

describe("compareMeasurements (logique pure)", () => {
  describe("higher is better", () => {
    it("80 -> 90 = improved", () => {
      expect(compareMeasurements("higher", 90, 80)).toBe("improved");
    });
    it("90 -> 80 = regressed", () => {
      expect(compareMeasurements("higher", 80, 90)).toBe("regressed");
    });
    it("80 -> 80 = stable", () => {
      expect(compareMeasurements("higher", 80, 80)).toBe("stable");
    });
  });

  describe("lower is better", () => {
    it("420 -> 380 = improved", () => {
      expect(compareMeasurements("lower", 380, 420)).toBe("improved");
    });
    it("380 -> 420 = regressed", () => {
      expect(compareMeasurements("lower", 420, 380)).toBe("regressed");
    });
    it("400 -> 400 = stable", () => {
      expect(compareMeasurements("lower", 400, 400)).toBe("stable");
    });
  });

  describe("unknown", () => {
    it("improvement_direction null -> unknown", () => {
      expect(compareMeasurements(null, 90, 80)).toBe("unknown");
    });
    it("improvement_direction invalide -> unknown (pas d'interprétation à l'aveugle)", () => {
      expect(compareMeasurements("up", 90, 80)).toBe("unknown");
    });
    it("unknown n'est jamais confondu avec stable", () => {
      expect(compareMeasurements(null, 80, 80)).toBe("unknown");
    });
  });
});

describe("computePercentage (logique pure)", () => {
  it("higher correctement calculé (72 -> 78 ≈ +8.33 %)", () => {
    expect(computePercentage("higher", 78, 72)).toBeCloseTo(8.33, 2);
  });

  it("lower correctement calculé (420 -> 380 ≈ +9.52 %)", () => {
    expect(computePercentage("lower", 380, 420)).toBeCloseTo(9.52, 2);
  });

  it("previous = 0 -> percentage null (aucune division tentée)", () => {
    expect(computePercentage("higher", 10, 0)).toBeNull();
    expect(computePercentage("lower", 10, 0)).toBeNull();
  });

  it("régression -> pourcentage négatif", () => {
    expect(computePercentage("higher", 80, 90)).toBeLessThan(0);
  });
});

describe("MetricsService", () => {
  let service: MetricsService;
  let repository: {
    athleteExists: jest.Mock;
    appUserExists: jest.Mock;
    metricTypeExists: jest.Mock;
    findAllMetricTypes: jest.Mock;
    createMeasurement: jest.Mock;
    findMeasurementsByAthleteAndMetric: jest.Mock;
    findLastTwoMeasurements: jest.Mock;
    findAthleteClubId: jest.Mock;
    findCoachClubId: jest.Mock;
    findClubScales: jest.Mock;
    saveClubScales: jest.Mock;
  };

  const ATHLETE_ID = "240fe60f-6e74-46ea-87a0-45872bd1f4fe";
  const METRIC_TYPE_ID = "d1e1d1e1-1111-4111-8111-111111111111";
  const COACH_ID = "c0a0c0a0-2222-4222-8222-222222222222";

  const measurement = (valeur: number, mesureLe: Date, overrides: Partial<{ coach_user_id: string | null; commentaire: string | null }> = {}) => ({
    id: `m-${valeur}-${mesureLe.getTime()}`,
    athlete_id: ATHLETE_ID,
    metric_type_id: METRIC_TYPE_ID,
    valeur: new Prisma.Decimal(valeur),
    mesure_le: mesureLe,
    coach_user_id: overrides.coach_user_id ?? null,
    commentaire: overrides.commentaire ?? null,
    created_at: mesureLe,
  });

  const metricType = (overrides: Partial<{ id: string; code: string; nom: string; unite: string | null; improvement_direction: string | null }> = {}) => ({
    id: METRIC_TYPE_ID,
    code: "force",
    nom: "Force",
    unite: "kg",
    description: null,
    improvement_direction: "higher",
    created_at: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    repository = {
      athleteExists: jest.fn(),
      appUserExists: jest.fn(),
      metricTypeExists: jest.fn(),
      findAllMetricTypes: jest.fn(),
      createMeasurement: jest.fn(),
      findMeasurementsByAthleteAndMetric: jest.fn(),
      findLastTwoMeasurements: jest.fn(),
      // Défaut : athlète sans club -> barème par défaut des metric_type.
      findAthleteClubId: jest.fn().mockResolvedValue(null),
      findCoachClubId: jest.fn(),
      findClubScales: jest.fn().mockResolvedValue([]),
      saveClubScales: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [MetricsService, { provide: MetricsRepository, useValue: repository }],
    }).compile();

    service = module.get<MetricsService>(MetricsService);
  });

  describe("createMeasurement", () => {
    it("création valide", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.metricTypeExists.mockResolvedValue(true);
      repository.createMeasurement.mockResolvedValue(measurement(90, new Date("2026-08-18T18:00:00.000Z")));

      const result = await service.createMeasurement(ATHLETE_ID, METRIC_TYPE_ID, {
        value: 90,
        measuredAt: "2026-08-18T18:00:00.000Z",
      });

      expect(result.value).toBe(90);
      expect(repository.appUserExists).not.toHaveBeenCalled();
    });

    it("utilise l'heure courante quand measuredAt est absent", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.metricTypeExists.mockResolvedValue(true);
      repository.createMeasurement.mockResolvedValue(measurement(90, new Date()));

      await service.createMeasurement(ATHLETE_ID, METRIC_TYPE_ID, { value: 90 });

      const [, , data] = repository.createMeasurement.mock.calls[0];
      expect(data.measuredAt).toBeInstanceOf(Date);
    });

    it("athlète absent -> NotFoundException (404)", async () => {
      repository.athleteExists.mockResolvedValue(false);

      await expect(
        service.createMeasurement(ATHLETE_ID, METRIC_TYPE_ID, { value: 90 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.createMeasurement).not.toHaveBeenCalled();
    });

    it("metric_type absent -> NotFoundException (404)", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.metricTypeExists.mockResolvedValue(false);

      await expect(
        service.createMeasurement(ATHLETE_ID, METRIC_TYPE_ID, { value: 90 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.createMeasurement).not.toHaveBeenCalled();
    });

    it("coachUserId fourni mais inexistant -> NotFoundException (404)", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.metricTypeExists.mockResolvedValue(true);
      repository.appUserExists.mockResolvedValue(false);

      await expect(
        service.createMeasurement(ATHLETE_ID, METRIC_TYPE_ID, { value: 90, coachUserId: COACH_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.createMeasurement).not.toHaveBeenCalled();
    });

    it("coachUserId fourni et existant -> création déléguée", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.metricTypeExists.mockResolvedValue(true);
      repository.appUserExists.mockResolvedValue(true);
      repository.createMeasurement.mockResolvedValue(
        measurement(90, new Date(), { coach_user_id: COACH_ID }),
      );

      const result = await service.createMeasurement(ATHLETE_ID, METRIC_TYPE_ID, {
        value: 90,
        coachUserId: COACH_ID,
      });

      expect(result.coachUserId).toBe(COACH_ID);
    });
  });

  describe("findMeasurements", () => {
    it("historique trié (pass-through du repository, mesure_le desc)", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.metricTypeExists.mockResolvedValue(true);
      repository.findMeasurementsByAthleteAndMetric.mockResolvedValue([
        measurement(90, new Date("2026-08-18T00:00:00.000Z")),
        measurement(80, new Date("2026-07-01T00:00:00.000Z")),
      ]);

      const result = await service.findMeasurements(ATHLETE_ID, METRIC_TYPE_ID);

      expect(result.map((m) => m.value)).toEqual([90, 80]);
    });

    it("athlète/métrique sans mesure -> []", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.metricTypeExists.mockResolvedValue(true);
      repository.findMeasurementsByAthleteAndMetric.mockResolvedValue([]);

      await expect(service.findMeasurements(ATHLETE_ID, METRIC_TYPE_ID)).resolves.toEqual([]);
    });

    it("athlète absent -> NotFoundException (404)", async () => {
      repository.athleteExists.mockResolvedValue(false);

      await expect(service.findMeasurements(ATHLETE_ID, METRIC_TYPE_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("getHighlights", () => {
    it("seules les améliorations sont retournées (régression et stable exclues)", async () => {
      repository.athleteExists.mockResolvedValue(true);
      const improving = metricType({ id: "m1", code: "force", improvement_direction: "higher" });
      const regressing = metricType({ id: "m2", code: "endurance", improvement_direction: "higher" });
      const stable = metricType({ id: "m3", code: "technique", improvement_direction: "higher" });
      repository.findAllMetricTypes.mockResolvedValue([improving, regressing, stable]);

      repository.findLastTwoMeasurements.mockImplementation((_athleteId: string, metricTypeId: string) => {
        if (metricTypeId === "m1") return [measurement(90, new Date()), measurement(80, new Date())];
        if (metricTypeId === "m2") return [measurement(70, new Date()), measurement(80, new Date())];
        return [measurement(50, new Date()), measurement(50, new Date())];
      });

      const result = await service.getHighlights(ATHLETE_ID);

      expect(result.highlights.map((h) => h.code)).toEqual(["force"]);
      expect(result.improvedCount).toBe(1);
    });

    it("métrique avec improvement_direction null -> unknown, exclue", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findAllMetricTypes.mockResolvedValue([
        metricType({ id: "m1", improvement_direction: null }),
      ]);
      repository.findLastTwoMeasurements.mockResolvedValue([
        measurement(90, new Date()),
        measurement(80, new Date()),
      ]);

      const result = await service.getHighlights(ATHLETE_ID);

      expect(result.highlights).toEqual([]);
      expect(result.improvedCount).toBe(0);
    });

    it("métrique avec une seule mesure -> exclue (pas assez d'historique)", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findAllMetricTypes.mockResolvedValue([metricType({ id: "m1" })]);
      repository.findLastTwoMeasurements.mockResolvedValue([measurement(90, new Date()), null]);

      const result = await service.getHighlights(ATHLETE_ID);

      expect(result.highlights).toEqual([]);
      expect(result.improvedCount).toBe(0);
    });

    it("maximum 3 highlights, triés par pourcentage décroissant, improvedCount reflète le total", async () => {
      repository.athleteExists.mockResolvedValue(true);
      const types = ["m1", "m2", "m3", "m4"].map((id) =>
        metricType({ id, code: id, improvement_direction: "higher" }),
      );
      repository.findAllMetricTypes.mockResolvedValue(types);

      // m1: +5%, m2: +20%, m3: +10%, m4: +2%
      repository.findLastTwoMeasurements.mockImplementation((_athleteId: string, metricTypeId: string) => {
        const table: Record<string, [number, number]> = {
          m1: [105, 100],
          m2: [120, 100],
          m3: [110, 100],
          m4: [102, 100],
        };
        const [current, previous] = table[metricTypeId];
        return [measurement(current, new Date()), measurement(previous, new Date())];
      });

      const result = await service.getHighlights(ATHLETE_ID);

      expect(result.improvedCount).toBe(4);
      expect(result.highlights).toHaveLength(3);
      expect(result.highlights.map((h) => h.code)).toEqual(["m2", "m3", "m1"]);
    });

    it("percentage null mais amélioré passe après les pourcentages calculables", async () => {
      repository.athleteExists.mockResolvedValue(true);
      const withPercentage = metricType({ id: "m1", code: "avec_pct", improvement_direction: "higher" });
      const withoutPercentage = metricType({ id: "m2", code: "sans_pct", improvement_direction: "higher" });
      repository.findAllMetricTypes.mockResolvedValue([withoutPercentage, withPercentage]);

      repository.findLastTwoMeasurements.mockImplementation((_athleteId: string, metricTypeId: string) => {
        if (metricTypeId === "m1") return [measurement(110, new Date()), measurement(100, new Date())];
        return [measurement(10, new Date()), measurement(0, new Date())]; // previous = 0 -> percentage null
      });

      const result = await service.getHighlights(ATHLETE_ID);

      expect(result.highlights.map((h) => h.code)).toEqual(["avec_pct", "sans_pct"]);
    });

    it("aucune progression -> tableau vide, HTTP 200 (pas une erreur)", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findAllMetricTypes.mockResolvedValue([]);

      const result = await service.getHighlights(ATHLETE_ID);

      expect(result).toEqual({ improvedCount: 0, highlights: [] });
    });

    it("athlète absent -> NotFoundException (404)", async () => {
      repository.athleteExists.mockResolvedValue(false);

      await expect(service.getHighlights(ATHLETE_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("getOverview", () => {
    it("métrique higher améliorée -> status improved, delta/percentage positifs", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findAllMetricTypes.mockResolvedValue([
        metricType({ id: "m1", code: "force", improvement_direction: "higher" }),
      ]);
      repository.findLastTwoMeasurements.mockResolvedValue([measurement(85, new Date()), measurement(80, new Date())]);

      const result = await service.getOverview(ATHLETE_ID);

      expect(result.metrics[0]).toMatchObject({
        status: "improved",
        currentValue: 85,
        previousValue: 80,
        delta: 5,
      });
      expect(result.metrics[0].percentage).toBeCloseTo(6.25, 2);
    });

    it("métrique higher en régression -> status regressed, delta négatif", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findAllMetricTypes.mockResolvedValue([
        metricType({ id: "m1", code: "technique", improvement_direction: "higher" }),
      ]);
      repository.findLastTwoMeasurements.mockResolvedValue([measurement(55, new Date()), measurement(60, new Date())]);

      const result = await service.getOverview(ATHLETE_ID);

      expect(result.metrics[0]).toMatchObject({ status: "regressed", currentValue: 55, previousValue: 60, delta: -5 });
      expect(result.metrics[0].percentage).toBeCloseTo(-8.33, 2);
    });

    it("métrique lower améliorée (temps de réaction) -> status improved malgré un delta brut négatif", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findAllMetricTypes.mockResolvedValue([
        metricType({ id: "m1", code: "temps_reaction", improvement_direction: "lower" }),
      ]);
      repository.findLastTwoMeasurements.mockResolvedValue([measurement(380, new Date()), measurement(420, new Date())]);

      const result = await service.getOverview(ATHLETE_ID);

      expect(result.metrics[0].status).toBe("improved");
      expect(result.metrics[0].delta).toBe(-40);
      expect(result.metrics[0].percentage).toBeGreaterThan(0);
    });

    it("métrique lower en régression -> status regressed", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findAllMetricTypes.mockResolvedValue([
        metricType({ id: "m1", code: "temps_reaction", improvement_direction: "lower" }),
      ]);
      repository.findLastTwoMeasurements.mockResolvedValue([measurement(420, new Date()), measurement(380, new Date())]);

      const result = await service.getOverview(ATHLETE_ID);

      expect(result.metrics[0].status).toBe("regressed");
    });

    it("valeur stable -> status stable, delta 0, percentage 0", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findAllMetricTypes.mockResolvedValue([metricType({ id: "m1", improvement_direction: "higher" })]);
      repository.findLastTwoMeasurements.mockResolvedValue([measurement(75, new Date()), measurement(75, new Date())]);

      const result = await service.getOverview(ATHLETE_ID);

      expect(result.metrics[0]).toMatchObject({ status: "stable", delta: 0, percentage: 0 });
    });

    it("aucune mesure -> status unknown, toutes les valeurs à null, mais le metric_type apparaît", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findAllMetricTypes.mockResolvedValue([metricType({ id: "m1", code: "souplesse" })]);
      repository.findLastTwoMeasurements.mockResolvedValue([null, null]);

      const result = await service.getOverview(ATHLETE_ID);

      expect(result.metrics).toEqual([
        expect.objectContaining({
          code: "souplesse",
          currentValue: null,
          previousValue: null,
          delta: null,
          percentage: null,
          status: "unknown",
          measuredAt: null,
        }),
      ]);
    });

    it("une seule mesure -> currentValue renseignée, status unknown, delta/percentage null", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findAllMetricTypes.mockResolvedValue([metricType({ id: "m1" })]);
      const only = measurement(90, new Date("2026-08-01T00:00:00.000Z"));
      repository.findLastTwoMeasurements.mockResolvedValue([only, null]);

      const result = await service.getOverview(ATHLETE_ID);

      expect(result.metrics[0]).toMatchObject({
        currentValue: 90,
        previousValue: null,
        delta: null,
        percentage: null,
        status: "unknown",
      });
      expect(result.metrics[0].measuredAt).toEqual(only.mesure_le);
    });

    it("improvement_direction null avec deux mesures -> status unknown, valeurs réelles conservées, delta/percentage null", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findAllMetricTypes.mockResolvedValue([metricType({ id: "m1", improvement_direction: null })]);
      repository.findLastTwoMeasurements.mockResolvedValue([measurement(90, new Date()), measurement(80, new Date())]);

      const result = await service.getOverview(ATHLETE_ID);

      expect(result.metrics[0]).toMatchObject({
        currentValue: 90,
        previousValue: 80,
        delta: null,
        percentage: null,
        status: "unknown",
      });
    });

    it("previous = 0 -> percentage null, mais status déterminable si la direction le permet", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findAllMetricTypes.mockResolvedValue([
        metricType({ id: "m1", improvement_direction: "higher" }),
      ]);
      repository.findLastTwoMeasurements.mockResolvedValue([measurement(10, new Date()), measurement(0, new Date())]);

      const result = await service.getOverview(ATHLETE_ID);

      expect(result.metrics[0].status).toBe("improved");
      expect(result.metrics[0].percentage).toBeNull();
      expect(result.metrics[0].delta).toBe(10);
    });

    it("toutes les metric_type sont présentes, y compris sans aucune mesure, dans l'ordre renvoyé par le repository", async () => {
      repository.athleteExists.mockResolvedValue(true);
      const types = [
        metricType({ id: "m1", code: "endurance" }),
        metricType({ id: "m2", code: "force" }),
        metricType({ id: "m3", code: "souplesse" }),
      ];
      repository.findAllMetricTypes.mockResolvedValue(types);
      repository.findLastTwoMeasurements.mockImplementation((_athleteId: string, metricTypeId: string) => {
        if (metricTypeId === "m2") return [measurement(85, new Date()), measurement(80, new Date())];
        return [null, null];
      });

      const result = await service.getOverview(ATHLETE_ID);

      expect(result.metrics.map((m) => m.code)).toEqual(["endurance", "force", "souplesse"]);
      expect(result.metrics.map((m) => m.status)).toEqual(["unknown", "improved", "unknown"]);
    });

    it("ordre déterministe : reflète l'ordre du repository (findAllMetricTypes), jamais un ordre codé en dur", async () => {
      repository.athleteExists.mockResolvedValue(true);
      const types = ["endurance", "force", "souplesse", "technique", "temps_reaction", "vitesse"].map((code) =>
        metricType({ id: code, code }),
      );
      repository.findAllMetricTypes.mockResolvedValue(types);
      repository.findLastTwoMeasurements.mockResolvedValue([null, null]);

      const result = await service.getOverview(ATHLETE_ID);

      expect(result.metrics.map((m) => m.code)).toEqual([
        "endurance",
        "force",
        "souplesse",
        "technique",
        "temps_reaction",
        "vitesse",
      ]);
    });

    it("athlète absent -> NotFoundException (404)", async () => {
      repository.athleteExists.mockResolvedValue(false);

      await expect(service.getOverview(ATHLETE_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findAllMetricTypes).not.toHaveBeenCalled();
    });

    it("ne modifie pas le comportement de getHighlights (toujours filtré sur improved uniquement)", async () => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findAllMetricTypes.mockResolvedValue([
        metricType({ id: "m1", code: "force", improvement_direction: "higher" }),
        metricType({ id: "m2", code: "technique", improvement_direction: "higher" }),
        metricType({ id: "m3", code: "souplesse" }),
      ]);
      repository.findLastTwoMeasurements.mockImplementation((_athleteId: string, metricTypeId: string) => {
        if (metricTypeId === "m1") return [measurement(85, new Date()), measurement(80, new Date())];
        if (metricTypeId === "m2") return [measurement(55, new Date()), measurement(60, new Date())];
        return [null, null];
      });

      const highlights = await service.getHighlights(ATHLETE_ID);
      const overview = await service.getOverview(ATHLETE_ID);

      expect(highlights.highlights.map((h) => h.code)).toEqual(["force"]);
      expect(overview.metrics.map((m) => m.code)).toEqual(["force", "technique", "souplesse"]);
      expect(overview.metrics.map((m) => m.status)).toEqual(["improved", "regressed", "unknown"]);
    });
  });

  describe("étoile de compétences — barème du club", () => {
    const CLUB_ID = "c1c1c1c1-0000-4000-8000-000000000001";
    const reactionType = () =>
      ({
        id: METRIC_TYPE_ID, code: "temps_reaction", nom: "Temps de réaction", unite: "ms", description: null,
        improvement_direction: "lower", created_at: new Date(),
        score_zero: new Prisma.Decimal(600), score_hundred: new Prisma.Decimal(250),
      }) as never;
    const m = (value: number, at: string) => ({
      id: `m-${value}`, athlete_id: ATHLETE_ID, metric_type_id: METRIC_TYPE_ID, valeur: new Prisma.Decimal(value),
      mesure_le: new Date(at), coach_user_id: null, commentaire: null, created_at: new Date(at),
    });

    beforeEach(() => {
      repository.athleteExists.mockResolvedValue(true);
      repository.findAllMetricTypes.mockResolvedValue([reactionType()]);
      repository.findLastTwoMeasurements.mockResolvedValue([m(380, "2026-09-08"), m(420, "2026-09-01")]);
    });

    it("athlète sans club : barème par défaut du metric_type", async () => {
      const overview = await service.getOverview(ATHLETE_ID);
      expect(overview.metrics[0]).toEqual(expect.objectContaining({ score: 63, previousScore: 51 }));
    });

    it("athlète d'un club avec barème : celui du club remplace le défaut", async () => {
      repository.findAthleteClubId.mockResolvedValue(CLUB_ID);
      repository.findClubScales.mockResolvedValue([
        { metric_type_id: METRIC_TYPE_ID, score_zero: new Prisma.Decimal(500), score_hundred: new Prisma.Decimal(300), updated_at: new Date() },
      ]);

      const overview = await service.getOverview(ATHLETE_ID);

      expect(repository.findClubScales).toHaveBeenCalledWith(CLUB_ID);
      expect(overview.metrics[0]).toEqual(expect.objectContaining({ score: 60, previousScore: 40 }));
    });

    it("coach sans club : 409, rien lu ni écrit", async () => {
      repository.findCoachClubId.mockResolvedValue(null);
      await expect(service.getClubScales(COACH_ID)).rejects.toBeInstanceOf(ConflictException);
      await expect(service.saveClubScales(COACH_ID, "u-coach", [])).rejects.toBeInstanceOf(ConflictException);
      expect(repository.saveClubScales).not.toHaveBeenCalled();
    });

    it("lecture : défaut, barème du club et barème appliqué par capacité", async () => {
      repository.findCoachClubId.mockResolvedValue(CLUB_ID);
      repository.findClubScales.mockResolvedValue([
        { metric_type_id: METRIC_TYPE_ID, score_zero: new Prisma.Decimal(500), score_hundred: new Prisma.Decimal(300), updated_at: new Date() },
      ]);

      const { scales } = await service.getClubScales(COACH_ID);

      expect(scales[0]).toEqual(
        expect.objectContaining({
          name: "Temps de réaction",
          direction: "lower",
          default: { scoreZero: 600, scoreHundred: 250 },
          club: { scoreZero: 500, scoreHundred: 300 },
          effective: { scoreZero: 500, scoreHundred: 300 },
        }),
      );
    });

    it.each([
      ["une seule valeur", { scoreZero: 500, scoreHundred: null }, /les deux valeurs/],
      ["valeurs égales", { scoreZero: 400, scoreHundred: 400 }, /différentes/],
      ["mauvais sens pour une capacité « lower »", { scoreZero: 250, scoreHundred: 600 }, /plus bas = meilleur/],
    ])("enregistrement refusé (%s) : 400 lisible, rien écrit", async (_label, values, message) => {
      repository.findCoachClubId.mockResolvedValue(CLUB_ID);

      const promise = service.saveClubScales(COACH_ID, "u-coach", [{ metricTypeId: METRIC_TYPE_ID, ...values }]);

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow(message);
      expect(repository.saveClubScales).not.toHaveBeenCalled();
    });

    it("enregistrement : barèmes complets enregistrés, null/null = retour au défaut ; capacité inconnue -> 404", async () => {
      repository.findCoachClubId.mockResolvedValue(CLUB_ID);

      await service.saveClubScales(COACH_ID, "u-coach", [{ metricTypeId: METRIC_TYPE_ID, scoreZero: 500, scoreHundred: 300 }]);
      expect(repository.saveClubScales).toHaveBeenLastCalledWith(CLUB_ID, "u-coach", [{ metricTypeId: METRIC_TYPE_ID, scoreZero: 500, scoreHundred: 300 }], []);

      await service.saveClubScales(COACH_ID, "u-coach", [{ metricTypeId: METRIC_TYPE_ID, scoreZero: null, scoreHundred: null }]);
      expect(repository.saveClubScales).toHaveBeenLastCalledWith(CLUB_ID, "u-coach", [], [METRIC_TYPE_ID]);

      await expect(
        service.saveClubScales(COACH_ID, "u-coach", [{ metricTypeId: "00000000-0000-4000-8000-000000000000", scoreZero: 1, scoreHundred: 2 }]),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
