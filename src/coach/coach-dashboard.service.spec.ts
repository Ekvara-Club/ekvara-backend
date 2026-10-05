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
    findUpcomingParticipationLinksForAthletes: jest.Mock;
    findUpcomingPreparationsForAthletes: jest.Mock;
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
        etat_forme: "actif",
        etat_forme_note: null,
        etat_forme_retour: null,
        etat_forme_updated_at: null,
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
      findUpcomingParticipationLinksForAthletes: jest.fn().mockResolvedValue([]),
      findUpcomingPreparationsForAthletes: jest.fn().mockResolvedValue([]),
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

    it("état de forme déclaré : exposé tel quel, raison en tête de « À surveiller » ; Actif ne produit aucune raison", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([
        athleteLink("a-1", "Kais", "Ali", {
          etat_forme: "blesse",
          etat_forme_note: "Entorse cheville",
          etat_forme_retour: new Date("2026-10-20T00:00:00.000Z"),
          etat_forme_updated_at: new Date("2026-10-05T10:00:00.000Z"),
        }),
        athleteLink("a-2", "Lina", "B"),
      ]);

      const dashboard = await service.getDashboard(COACH_ID);
      const summaries = await service.getAthleteSummaries(COACH_ID);

      const injured = dashboard.athletesNeedingAttention.find((a) => a.athlete.id === "a-1")!;
      expect(injured.reasons[0]).toEqual({ type: "CONDITION_INJURED" });
      const active = dashboard.athletesNeedingAttention.find((a) => a.athlete.id === "a-2");
      expect(active?.reasons ?? []).not.toContainEqual(expect.objectContaining({ type: expect.stringMatching(/^CONDITION_/) }));
      expect(summaries.find((a) => a.id === "a-1")?.condition).toEqual({
        status: "blesse",
        note: "Entorse cheville",
        expectedReturn: "2026-10-20",
        updatedAt: new Date("2026-10-05T10:00:00.000Z"),
      });
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

  // Règle unique Athlete/Coach : voir competitions/next-competition.ts (testée
  // pour elle-même). Ici : le branchement Coach (candidats, isolation, DTO).
  describe("prochaine compétition — préparations du coach (règle partagée avec la vue Athlete)", () => {
    const inDays = (n: number) => {
      const now = new Date();
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n));
    };

    const competition = (id: string, nom: string, offset: number) => ({
      id,
      nom,
      date_debut: inDays(offset),
      ville: "Eaubonne",
      pays: "France",
      niveau: "national",
    });

    const prep = (athleteId: string, comp: ReturnType<typeof competition>, overrides: Record<string, unknown> = {}) => ({
      athlete_id: athleteId,
      competition_id: comp.id,
      statut: "pret",
      categorie_age_prevue: "Senior",
      categorie_poids_prevue: "-68kg",
      competition: comp,
      ...overrides,
    });

    const participation = (athleteId: string, comp: ReturnType<typeof competition>, overrides: Record<string, unknown> = {}) => ({
      athlete_id: athleteId,
      categorie_poids: "-74kg",
      categorie_age: "cadet",
      competition: { ...comp, date_fin: null, lieu: null, sources: [] },
      ...overrides,
    });

    beforeEach(() => {
      coachRepository.findAthletesForCoach.mockResolvedValue([athleteLink("a-1", "Kais", "Dilmi")]);
    });

    it("préparation future seule -> prochaine compétition, avec catégories prévues et statut (cas Kaïs)", async () => {
      const champ = competition("c-champ", "Championnat de France seniors", 173);
      dashboardRepository.findUpcomingPreparationsForAthletes.mockResolvedValue([prep("a-1", champ)]);

      const [summary] = await service.getAthleteSummaries(COACH_ID);

      expect(summary.nextCompetition).toMatchObject({
        source: "coach_preparation",
        id: "c-champ",
        name: "Championnat de France seniors",
        city: "Eaubonne",
        country: "France",
        // Aucune participation : jamais de catégorie OFFICIELLE inventée.
        weightCategory: null,
        ageCategory: null,
        preparation: { status: "pret", targetAgeCategory: "Senior", targetWeightCategory: "-68kg" },
        daysUntil: 173,
      });
    });

    it("plusieurs préparations -> la plus proche (10 oct. avant 13 mars avant 20 avr.), pas la plus éloignée", async () => {
      dashboardRepository.findUpcomingPreparationsForAthletes.mockResolvedValue([
        prep("a-1", competition("c-apr", "Avril", 200)),
        prep("a-1", competition("c-oct", "Octobre", 19)),
        prep("a-1", competition("c-mar", "Mars", 173)),
      ]);

      const [summary] = await service.getAthleteSummaries(COACH_ID);

      expect(summary.nextCompetition).toMatchObject({ id: "c-oct", name: "Octobre" });
    });

    it("préparation forfait -> jamais prochaine compétition (règle #13) ; la suivante active est retenue", async () => {
      dashboardRepository.findUpcomingPreparationsForAthletes.mockResolvedValue([
        prep("a-1", competition("c-f", "Forfait", 10), { statut: "forfait" }),
        prep("a-1", competition("c-ok", "Suivante", 40), { statut: "selectionne" }),
      ]);

      const [summary] = await service.getAthleteSummaries(COACH_ID);

      expect(summary.nextCompetition).toMatchObject({ id: "c-ok", preparation: { status: "selectionne" } });
    });

    it("uniquement forfait -> null (empty state)", async () => {
      dashboardRepository.findUpcomingPreparationsForAthletes.mockResolvedValue([
        prep("a-1", competition("c-f", "Forfait", 10), { statut: "forfait" }),
      ]);

      const [summary] = await service.getAthleteSummaries(COACH_ID);

      expect(summary.nextCompetition).toBeNull();
    });

    it("aucune participation ni préparation -> null (empty state)", async () => {
      const [summary] = await service.getAthleteSummaries(COACH_ID);

      expect(summary.nextCompetition).toBeNull();
    });

    it("participation seule -> source participation, sans préparation", async () => {
      const comp = competition("c-1", "Paris Open", 30);
      dashboardRepository.findUpcomingParticipationsForAthletes.mockResolvedValue([participation("a-1", comp)]);

      const [summary] = await service.getAthleteSummaries(COACH_ID);

      expect(summary.nextCompetition).toMatchObject({
        source: "participation",
        id: "c-1",
        weightCategory: "-74kg",
        ageCategory: "cadet",
        preparation: null,
      });
    });

    it("participation + préparation sur la MÊME compétition -> UNE seule, participation prioritaire, catégories officielles non falsifiées", async () => {
      const comp = competition("c-1", "Paris Open", 30);
      dashboardRepository.findUpcomingParticipationsForAthletes.mockResolvedValue([participation("a-1", comp)]);
      dashboardRepository.findUpcomingParticipationLinksForAthletes.mockResolvedValue([{ athlete_id: "a-1", competition_id: "c-1" }]);
      dashboardRepository.findUpcomingPreparationsForAthletes.mockResolvedValue([prep("a-1", comp)]);

      const dashboard = await service.getDashboard(COACH_ID);
      const [summary] = await service.getAthleteSummaries(COACH_ID);

      expect(summary.nextCompetition).toMatchObject({
        source: "participation",
        weightCategory: "-74kg",
        ageCategory: "cadet",
        preparation: { status: "pret", targetWeightCategory: "-68kg" },
      });
      expect(dashboard.upcomingCompetitions).toHaveLength(1);
      expect(dashboard.upcomingCompetitions[0].athleteCount).toBe(1);
    });

    it("participation plus proche qu'une préparation -> la participation ; préparation plus proche -> la préparation", async () => {
      dashboardRepository.findUpcomingParticipationsForAthletes.mockResolvedValue([participation("a-1", competition("c-p", "P", 90))]);
      dashboardRepository.findUpcomingPreparationsForAthletes.mockResolvedValue([prep("a-1", competition("c-r", "R", 20))]);
      expect((await service.getAthleteSummaries(COACH_ID))[0].nextCompetition).toMatchObject({ id: "c-r", source: "coach_preparation" });

      dashboardRepository.findUpcomingParticipationsForAthletes.mockResolvedValue([participation("a-1", competition("c-p", "P", 10))]);
      expect((await service.getAthleteSummaries(COACH_ID))[0].nextCompetition).toMatchObject({ id: "c-p", source: "participation" });
    });

    it("compétition dont la participation est annulée/retirée : la préparation du coach n'est pas présentée seule", async () => {
      const comp = competition("c-1", "Paris Open", 30);
      dashboardRepository.findUpcomingPreparationsForAthletes.mockResolvedValue([prep("a-1", comp)]);
      dashboardRepository.findUpcomingParticipationLinksForAthletes.mockResolvedValue([{ athlete_id: "a-1", competition_id: "c-1" }]);

      const [summary] = await service.getAthleteSummaries(COACH_ID);

      expect(summary.nextCompetition).toBeNull();
    });

    it("isolation par athlète : la préparation d'un athlète n'apparaît jamais chez un autre", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([athleteLink("a-1", "Kais", "Dilmi"), athleteLink("a-2", "Adam", "Zidane")]);
      dashboardRepository.findUpcomingPreparationsForAthletes.mockResolvedValue([prep("a-2", competition("c-2", "Pour A2", 20))]);

      const summaries = await service.getAthleteSummaries(COACH_ID);

      expect(summaries.find((s) => s.id === "a-1")!.nextCompetition).toBeNull();
      expect(summaries.find((s) => s.id === "a-2")!.nextCompetition).toMatchObject({ id: "c-2" });
    });

    it("ISOLATION MULTI-COACH : seules les préparations du coach COURANT sont demandées (coachId passé au repository), depuis minuit UTC", async () => {
      await service.getAthleteSummaries(COACH_ID);

      const [athleteIds, coachId, fromDate] = dashboardRepository.findUpcomingPreparationsForAthletes.mock.calls[0];
      expect(athleteIds).toEqual(["a-1"]);
      expect(coachId).toBe(COACH_ID);
      expect(fromDate).toEqual(inDays(0));
      // La même règle "à venir" est appliquée aux participations (une seule définition de "aujourd'hui").
      expect(dashboardRepository.findUpcomingParticipationsForAthletes.mock.calls[0][1]).toEqual(inDays(0));
      expect(dashboardRepository.findUpcomingParticipationLinksForAthletes.mock.calls[0][1]).toEqual(inDays(0));
    });

    it("dashboard : une compétition seulement préparée compte comme 'à venir' et apparaît dans upcomingCompetitions, sans doublon", async () => {
      coachRepository.findAthletesForCoach.mockResolvedValue([athleteLink("a-1", "Kais", "Dilmi"), athleteLink("a-2", "Adam", "Zidane")]);
      const champ = competition("c-champ", "Championnat", 173);
      dashboardRepository.findUpcomingPreparationsForAthletes.mockResolvedValue([prep("a-1", champ), prep("a-2", champ)]);

      const dashboard = await service.getDashboard(COACH_ID);

      expect(dashboard.summary.athletesWithUpcomingCompetition).toBe(2);
      expect(dashboard.upcomingCompetitions).toHaveLength(1);
      expect(dashboard.upcomingCompetitions[0].athleteCount).toBe(2);
    });

    it("jamais de champ privé dans la réponse (note_coach / objectif), même si la ligne source en contient", async () => {
      dashboardRepository.findUpcomingPreparationsForAthletes.mockResolvedValue([
        prep("a-1", competition("c-1", "Champ", 20), { note_coach: "NOTE-SECRETE", objectif: "OBJ-SECRET", coach_id: "coach-1" }),
      ]);

      const serialized = JSON.stringify(await service.getAthleteSummaries(COACH_ID));

      expect(serialized).not.toContain("NOTE-SECRETE");
      expect(serialized).not.toContain("OBJ-SECRET");
      expect(serialized).not.toMatch(/note_coach|coachNote|objectif|objective|coach_id/);
    });

    it("ne demande que des lectures : aucune écriture de participation n'existe sur ce service", () => {
      const writers = Object.getOwnPropertyNames(CoachDashboardService.prototype).filter((name) => /^(create|update|delete|participate)/i.test(name));
      expect(writers).toEqual([]);
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
