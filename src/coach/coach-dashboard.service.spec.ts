import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { CoachDashboardService } from "./coach-dashboard.service";
import { CoachRepository } from "./coach.repository";
import { CoachGroupsRepository } from "./coach-groups.repository";
import { CoachDashboardRepository } from "./coach-dashboard.repository";

describe("CoachDashboardService", () => {
  let service: CoachDashboardService;
  let coachRepository: { findAthletesForCoach: jest.Mock };
  let coachGroupsRepository: { findGroupsForCoach: jest.Mock };
  let dashboardRepository: {
    findGroupWithMemberIds: jest.Mock;
    findGroupsForAthletes: jest.Mock;
    findWeightLogsForAthletes: jest.Mock;
    findActiveWeightTargetsForAthletes: jest.Mock;
    findAllMetricTypes: jest.Mock;
    findMeasurementsForAthletes: jest.Mock;
    findUpcomingParticipationsForAthletes: jest.Mock;
    findUpcomingTrainingsForAthletes: jest.Mock;
    findActiveGoalsForAthletes: jest.Mock;
  };

  const COACH_ID = "coach-1";

  function athleteLink(id: string, prenom: string, nom: string, overrides: Partial<Record<string, unknown>> = {}) {
    return {
      athlete: {
        id,
        categorie_age: "senior",
        grade: "1er dan",
        niveau_sportif: "national",
        app_user: { id: `u-${id}`, email: `${id}@test.fr`, nom, prenom },
        ...overrides,
      },
    };
  }

  beforeEach(async () => {
    coachRepository = { findAthletesForCoach: jest.fn() };
    coachGroupsRepository = { findGroupsForCoach: jest.fn().mockResolvedValue([]) };
    dashboardRepository = {
      findGroupWithMemberIds: jest.fn(),
      findGroupsForAthletes: jest.fn().mockResolvedValue([]),
      findWeightLogsForAthletes: jest.fn().mockResolvedValue([]),
      findActiveWeightTargetsForAthletes: jest.fn().mockResolvedValue([]),
      findAllMetricTypes: jest.fn().mockResolvedValue([]),
      findMeasurementsForAthletes: jest.fn().mockResolvedValue([]),
      findUpcomingParticipationsForAthletes: jest.fn().mockResolvedValue([]),
      findUpcomingTrainingsForAthletes: jest.fn().mockResolvedValue([]),
      findActiveGoalsForAthletes: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoachDashboardService,
        { provide: CoachRepository, useValue: coachRepository },
        { provide: CoachGroupsRepository, useValue: coachGroupsRepository },
        { provide: CoachDashboardRepository, useValue: dashboardRepository },
      ],
    }).compile();

    service = module.get(CoachDashboardService);
  });

  describe("roster vide", () => {
    it("getAthleteSummaries -> []", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([]);
      expect(await service.getAthleteSummaries(COACH_ID)).toEqual([]);
    });

    it("getDashboard -> summary à zéro, listes vides, pas de 500", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([]);

      const dashboard = await service.getDashboard(COACH_ID);

      expect(dashboard.summary).toEqual({
        athleteCount: 0,
        groupCount: 0,
        athletesWithUpcomingCompetition: 0,
        athletesOnTargetWeight: 0,
        athletesAboveTargetWeight: 0,
        athletesBelowTargetWeight: 0,
        athletesWithoutWeightTarget: 0,
        athletesImproving: 0,
        athletesDeclining: 0,
        athletesWithoutRecentMetrics: 0,
      });
      expect(dashboard.groups).toEqual([]);
      expect(dashboard.upcomingCompetitions).toEqual([]);
      expect(dashboard.athletesNeedingAttention).toEqual([]);
      expect(dashboard.recentActivity).toEqual([]);
    });
  });

  describe("athlète sans aucune donnée", () => {
    it("weight/progression/nextCompetition/nextTraining/primaryGoal entièrement null, aucun crash", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([athleteLink("a-1", "Kais", "Ali")]);
      dashboardRepository.findAllMetricTypes.mockResolvedValue([
        { id: "mt-1", improvement_direction: "higher" },
      ]);

      const [summary] = await service.getAthleteSummaries(COACH_ID);

      expect(summary.weight).toEqual({
        currentWeight: null,
        measuredAt: null,
        target: null,
        differenceToTarget: null,
        weeklyChange: null,
      });
      expect(summary.progression).toEqual({
        improvedCount: 0,
        decliningCount: 0,
        unknownCount: 1,
        evaluatedCount: 0,
        overallStatus: null,
      });
      expect(summary.nextCompetition).toBeNull();
      expect(summary.nextTraining).toBeNull();
      expect(summary.primaryGoal).toBeNull();
      expect(summary.groups).toEqual([]);
    });
  });

  describe("progression métrique — cas critique temps de réaction", () => {
    it("420ms -> 380ms avec direction='lower' = improved, jamais déterminé depuis le signe brut du delta", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([athleteLink("a-1", "Kais", "Ali")]);
      dashboardRepository.findAllMetricTypes.mockResolvedValue([
        { id: "mt-reaction", improvement_direction: "lower" },
      ]);
      dashboardRepository.findMeasurementsForAthletes.mockResolvedValue([
        { athlete_id: "a-1", metric_type_id: "mt-reaction", valeur: new Prisma.Decimal(380), mesure_le: new Date("2026-08-15") },
        { athlete_id: "a-1", metric_type_id: "mt-reaction", valeur: new Prisma.Decimal(420), mesure_le: new Date("2026-08-01") },
      ]);

      const [summary] = await service.getAthleteSummaries(COACH_ID);

      expect(summary.progression).toEqual({
        improvedCount: 1,
        decliningCount: 0,
        unknownCount: 0,
        evaluatedCount: 1,
        overallStatus: null,
      });
    });

    it("un vrai déclin (direction='higher', 100 -> 80) compte dans decliningCount, jamais improvedCount", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([athleteLink("a-1", "Kais", "Ali")]);
      dashboardRepository.findAllMetricTypes.mockResolvedValue([
        { id: "mt-force", improvement_direction: "higher" },
      ]);
      dashboardRepository.findMeasurementsForAthletes.mockResolvedValue([
        { athlete_id: "a-1", metric_type_id: "mt-force", valeur: new Prisma.Decimal(80), mesure_le: new Date("2026-08-15") },
        { athlete_id: "a-1", metric_type_id: "mt-force", valeur: new Prisma.Decimal(100), mesure_le: new Date("2026-08-01") },
      ]);

      const [summary] = await service.getAthleteSummaries(COACH_ID);

      expect(summary.progression.decliningCount).toBe(1);
      expect(summary.progression.improvedCount).toBe(0);
    });

    it("improvement_direction invalide/absent -> unknownCount, jamais interprété", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([athleteLink("a-1", "Kais", "Ali")]);
      dashboardRepository.findAllMetricTypes.mockResolvedValue([{ id: "mt-x", improvement_direction: null }]);
      dashboardRepository.findMeasurementsForAthletes.mockResolvedValue([
        { athlete_id: "a-1", metric_type_id: "mt-x", valeur: new Prisma.Decimal(10), mesure_le: new Date("2026-08-15") },
        { athlete_id: "a-1", metric_type_id: "mt-x", valeur: new Prisma.Decimal(5), mesure_le: new Date("2026-08-01") },
      ]);

      const [summary] = await service.getAthleteSummaries(COACH_ID);

      expect(summary.progression).toEqual({
        improvedCount: 0,
        decliningCount: 0,
        unknownCount: 1,
        evaluatedCount: 0,
        overallStatus: null,
      });
    });
  });

  describe("poids — au poids / au-dessus / en dessous", () => {
    function withWeight(currentKg: number, targetKg: number) {
      coachRepository.findAthletesForCoach.mockResolvedValue([athleteLink("a-1", "Kais", "Ali")]);
      dashboardRepository.findWeightLogsForAthletes.mockResolvedValue([
        { athlete_id: "a-1", valeur_kg: new Prisma.Decimal(currentKg), date_mesure: new Date("2026-08-15") },
      ]);
      dashboardRepository.findActiveWeightTargetsForAthletes.mockResolvedValue([
        { athlete_id: "a-1", poids_cible_kg: new Prisma.Decimal(targetKg), date_cible: null, competition_id: null, created_at: new Date() },
      ]);
      // Neutralise NO_METRIC_DATA (hors sujet ici) : au moins une mesure existe.
      dashboardRepository.findAllMetricTypes.mockResolvedValue([{ id: "mt-1", improvement_direction: "higher" }]);
      dashboardRepository.findMeasurementsForAthletes.mockResolvedValue([
        { athlete_id: "a-1", metric_type_id: "mt-1", valeur: new Prisma.Decimal(10), mesure_le: new Date() },
      ]);
    }

    it("exactement à la cible (74.0 == 74.0) -> athletesOnTargetWeight, aucune raison d'attention poids", async () => {
      withWeight(74.0, 74.0);
      const dashboard = await service.getDashboard(COACH_ID);
      expect(dashboard.summary.athletesOnTargetWeight).toBe(1);
      expect(dashboard.summary.athletesAboveTargetWeight).toBe(0);
      expect(dashboard.athletesNeedingAttention).toEqual([]);
    });

    it("au-dessus (75.0 vs 74.0) -> athletesAboveTargetWeight + raison WEIGHT_ABOVE_TARGET", async () => {
      withWeight(75.0, 74.0);
      const dashboard = await service.getDashboard(COACH_ID);
      expect(dashboard.summary.athletesAboveTargetWeight).toBe(1);
      expect(dashboard.athletesNeedingAttention[0].reasons).toContainEqual({ type: "WEIGHT_ABOVE_TARGET", value: 1 });
    });

    it("en dessous (73.0 vs 74.0) -> athletesBelowTargetWeight + raison WEIGHT_BELOW_TARGET", async () => {
      withWeight(73.0, 74.0);
      const dashboard = await service.getDashboard(COACH_ID);
      expect(dashboard.summary.athletesBelowTargetWeight).toBe(1);
      expect(dashboard.athletesNeedingAttention[0].reasons).toContainEqual({ type: "WEIGHT_BELOW_TARGET", value: -1 });
    });

    it("aucun objectif -> athletesWithoutWeightTarget + raison NO_WEIGHT_TARGET", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([athleteLink("a-1", "Kais", "Ali")]);
      dashboardRepository.findWeightLogsForAthletes.mockResolvedValue([
        { athlete_id: "a-1", valeur_kg: new Prisma.Decimal(74), date_mesure: new Date() },
      ]);

      const dashboard = await service.getDashboard(COACH_ID);

      expect(dashboard.summary.athletesWithoutWeightTarget).toBe(1);
      expect(dashboard.athletesNeedingAttention[0].reasons).toContainEqual({ type: "NO_WEIGHT_TARGET" });
    });

    it("weeklyChange calculé en mémoire, cohérent avec l'algorithme WeightsService (référence >= 7 jours)", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([athleteLink("a-1", "Kais", "Ali")]);
      const now = new Date("2026-08-15T00:00:00.000Z");
      const weekAgo = new Date("2026-08-08T00:00:00.000Z");
      dashboardRepository.findWeightLogsForAthletes.mockResolvedValue([
        { athlete_id: "a-1", valeur_kg: new Prisma.Decimal(74.5), date_mesure: now },
        { athlete_id: "a-1", valeur_kg: new Prisma.Decimal(74.8), date_mesure: weekAgo },
      ]);

      const [summary] = await service.getAthleteSummaries(COACH_ID);

      expect(summary.weight.weeklyChange).toBe(-0.3);
    });
  });

  describe("NO_METRIC_DATA / athletesWithoutRecentMetrics", () => {
    it("aucune mesure du tout -> NO_METRIC_DATA + compteur, distinct d'un simple unknownCount ponctuel", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([athleteLink("a-1", "Kais", "Ali")]);
      dashboardRepository.findAllMetricTypes.mockResolvedValue([{ id: "mt-1", improvement_direction: "higher" }]);
      dashboardRepository.findMeasurementsForAthletes.mockResolvedValue([]);

      const dashboard = await service.getDashboard(COACH_ID);

      expect(dashboard.summary.athletesWithoutRecentMetrics).toBe(1);
      expect(dashboard.athletesNeedingAttention[0].reasons).toContainEqual({ type: "NO_METRIC_DATA" });
    });

    it("une seule mesure existante (pas de comparaison possible) -> unknownCount mais PAS NO_METRIC_DATA", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([athleteLink("a-1", "Kais", "Ali")]);
      dashboardRepository.findAllMetricTypes.mockResolvedValue([{ id: "mt-1", improvement_direction: "higher" }]);
      dashboardRepository.findMeasurementsForAthletes.mockResolvedValue([
        { athlete_id: "a-1", metric_type_id: "mt-1", valeur: new Prisma.Decimal(10), mesure_le: new Date() },
      ]);

      const dashboard = await service.getDashboard(COACH_ID);

      expect(dashboard.summary.athletesWithoutRecentMetrics).toBe(0);
      expect(dashboard.athletesNeedingAttention.flatMap((a) => a.reasons)).not.toContainEqual(
        expect.objectContaining({ type: "NO_METRIC_DATA" }),
      );
    });
  });

  describe("prochaine compétition", () => {
    it("une compétition catalogue sans participation n'apparaît jamais comme prochaine compétition (seules les participations comptent)", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([athleteLink("a-1", "Kais", "Ali")]);
      dashboardRepository.findUpcomingParticipationsForAthletes.mockResolvedValue([]);

      const [summary] = await service.getAthleteSummaries(COACH_ID);

      expect(summary.nextCompetition).toBeNull();
    });

    it("weightCategory vient de la participation (categorie_poids), jamais d'un champ athlete inexistant", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([athleteLink("a-1", "Kais", "Ali")]);
      // Relative à l'exécution du test (jamais une date ISO figée) : ce test
      // asserte daysUntil > 0, donc dépend de `new Date()` au moment du run
      // (voir CoachDashboardService) — une date passée en dur finit TOUJOURS
      // par tomber dans le passé (voir rapport Ticket #10B).
      const startDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
      dashboardRepository.findUpcomingParticipationsForAthletes.mockResolvedValue([
        {
          athlete_id: "a-1",
          categorie_poids: "-74kg",
          categorie_age: "senior",
          competition: { id: "c-1", nom: "Paris Open", date_debut: startDate, date_fin: null, lieu: null, ville: "Paris", pays: "France", niveau: "national", sources: [] },
        },
      ]);

      const [summary] = await service.getAthleteSummaries(COACH_ID);

      expect(summary.nextCompetition).toMatchObject({ id: "c-1", name: "Paris Open", weightCategory: "-74kg" });
      expect(summary.nextCompetition!.daysUntil).toBeGreaterThan(0);
    });

    it("dédoublonne par competition.id : deux athlètes inscrits à la même compétition -> une seule entrée upcomingCompetitions avec athleteCount 2", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([
        athleteLink("a-1", "Kais", "Ali"),
        athleteLink("a-2", "Adam", "Zidane"),
      ]);
      const startDate = new Date("2026-09-05T00:00:00.000Z");
      const competition = { id: "c-1", nom: "Paris Open", date_debut: startDate, date_fin: null, lieu: null, ville: "Paris", pays: "France", niveau: "national", sources: [] };
      dashboardRepository.findUpcomingParticipationsForAthletes.mockResolvedValue([
        { athlete_id: "a-1", categorie_poids: "-74kg", categorie_age: "senior", competition },
        { athlete_id: "a-2", categorie_poids: "-68kg", categorie_age: "senior", competition },
      ]);

      const dashboard = await service.getDashboard(COACH_ID);

      expect(dashboard.upcomingCompetitions).toHaveLength(1);
      expect(dashboard.upcomingCompetitions[0].athleteCount).toBe(2);
      expect(dashboard.upcomingCompetitions[0].athletes.map((a) => a.id).sort()).toEqual(["a-1", "a-2"]);
    });
  });

  describe("primaryGoal — réutilise computeGoalProgress, pas de recalcul divergent", () => {
    it("progressPercentage cohérent avec goal_step completed/total", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([athleteLink("a-1", "Kais", "Ali")]);
      dashboardRepository.findActiveGoalsForAthletes.mockResolvedValue([
        {
          athlete_id: "a-1",
          id: "goal-1",
          titre: "Médaille régionale",
          date_cible: new Date("2026-09-01T00:00:00.000Z"),
          goal_step: [
            { id: "s-1", titre: "s1", ordre: 0, completed: true, completed_at: new Date() },
            { id: "s-2", titre: "s2", ordre: 1, completed: false, completed_at: null },
          ],
        },
      ]);

      const [summary] = await service.getAthleteSummaries(COACH_ID);

      expect(summary.primaryGoal).toMatchObject({
        id: "goal-1",
        title: "Médaille régionale",
        completedSteps: 1,
        totalSteps: 2,
        progressPercentage: 50,
      });
    });
  });

  describe("filtre par groupe (ticket §16)", () => {
    it("groupId inconnu ou n'appartenant pas au coach -> ForbiddenException (jamais 404)", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([athleteLink("a-1", "Kais", "Ali")]);
      dashboardRepository.findGroupWithMemberIds.mockResolvedValue(null);

      await expect(service.getAthleteSummaries(COACH_ID, "group-x")).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("groupId d'un autre coach -> ForbiddenException", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([athleteLink("a-1", "Kais", "Ali")]);
      dashboardRepository.findGroupWithMemberIds.mockResolvedValue({ coach_id: "other-coach", members: [] });

      await expect(service.getAthleteSummaries(COACH_ID, "group-x")).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("ne retourne que les athlètes membres du groupe demandé", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([
        athleteLink("a-1", "Kais", "Ali"),
        athleteLink("a-2", "Adam", "Zidane"),
      ]);
      dashboardRepository.findGroupWithMemberIds.mockResolvedValue({
        coach_id: COACH_ID,
        members: [{ athlete_id: "a-1" }],
      });

      const result = await service.getAthleteSummaries(COACH_ID, "group-elite");

      expect(result.map((a) => a.id)).toEqual(["a-1"]);
    });
  });

  describe("getAthleteDashboard (fiche unique)", () => {
    it("athlète absent du roster (incohérence défensive) -> NotFoundException", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([]);
      await expect(service.getAthleteDashboard(COACH_ID, "a-inconnu")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("utilise exactement le même mapper que la liste (même forme de sortie)", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([athleteLink("a-1", "Kais", "Ali")]);

      const [fromList] = await service.getAthleteSummaries(COACH_ID);
      const single = await service.getAthleteDashboard(COACH_ID, "a-1");

      expect(single).toEqual(fromList);
    });
  });
});
