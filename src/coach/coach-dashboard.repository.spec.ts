import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { MetricsRepository } from "../metrics/metrics.repository";
import { CoachDashboardRepository } from "./coach-dashboard.repository";

// Test d'intégration contre la vraie base Postgres locale : les requêtes
// batch (where athlete_id IN (...), tri multi-colonnes) dépendent de
// comportements Prisma/SQL réels. Fixtures jetables nettoyées en afterEach
// via cascade sur app_user.
describe("CoachDashboardRepository (intégration Postgres)", () => {
  let prisma: PrismaService;
  let repository: CoachDashboardRepository;
  const runId = Date.now();
  const createdUserIds: string[] = [];
  const createdCompetitionIds: string[] = [];
  let counter = 0;

  beforeAll(() => {
    prisma = new PrismaService();
    repository = new CoachDashboardRepository(prisma, new MetricsRepository(prisma));
  }, 30000);

  afterEach(async () => {
    if (createdCompetitionIds.length > 0) {
      await prisma.competition.deleteMany({ where: { id: { in: createdCompetitionIds } } });
      createdCompetitionIds.length = 0;
    }
    if (createdUserIds.length > 0) {
      await prisma.app_user.deleteMany({ where: { id: { in: createdUserIds } } });
      createdUserIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  }, 30000);

  async function makeCoach(): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-cd-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `F${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return profile.id;
  }

  async function makeAthlete(): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-cd-athlete-${runId}-${counter}@test.fr`, nom: `Nom${counter}`, prenom: `Prenom${counter}` },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
    return athlete.id;
  }

  async function makeCompetition(daysFromNow: number): Promise<string> {
    const date = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
    const competition = await prisma.competition.create({
      data: { nom: `Fixture competition ${runId}-${daysFromNow}`, date_debut: date },
    });
    createdCompetitionIds.push(competition.id);
    return competition.id;
  }

  describe("findGroupWithMemberIds", () => {
    it("renvoie coach_id et les athlete_id membres, null si inconnu", async () => {
      const coachId = await makeCoach();
      const athleteId = await makeAthlete();
      const group = await prisma.coach_group.create({ data: { coach_id: coachId, name: `G ${runId}` } });
      await prisma.coach_group_athlete.create({ data: { group_id: group.id, athlete_id: athleteId } });

      const result = await repository.findGroupWithMemberIds(group.id);
      expect(result?.coach_id).toBe(coachId);
      expect(result?.members.map((m) => m.athlete_id)).toEqual([athleteId]);

      expect(await repository.findGroupWithMemberIds("00000000-0000-4000-8000-000000000000")).toBeNull();
    });
  });

  describe("findGroupsForAthletes", () => {
    it("ne renvoie que les groupes DE CE COACH, jamais ceux d'un autre coach sur le même athlète", async () => {
      const coachAId = await makeCoach();
      const coachBId = await makeCoach();
      const athleteId = await makeAthlete();
      const groupA = await prisma.coach_group.create({ data: { coach_id: coachAId, name: `A ${runId}` } });
      const groupB = await prisma.coach_group.create({ data: { coach_id: coachBId, name: `B ${runId}` } });
      await prisma.coach_group_athlete.create({ data: { group_id: groupA.id, athlete_id: athleteId } });
      await prisma.coach_group_athlete.create({ data: { group_id: groupB.id, athlete_id: athleteId } });

      const result = await repository.findGroupsForAthletes([athleteId], coachAId);

      expect(result).toHaveLength(1);
      expect(result[0].coach_group.id).toBe(groupA.id);
    });
  });

  describe("findWeightLogsForAthletes / findActiveWeightTargetsForAthletes", () => {
    it("isole les logs par athlète, triés date_mesure desc au sein de chaque athlète", async () => {
      const athleteAId = await makeAthlete();
      const athleteBId = await makeAthlete();
      await prisma.weight_log.create({ data: { athlete_id: athleteAId, valeur_kg: 74.0, date_mesure: new Date("2026-08-01") } });
      await prisma.weight_log.create({ data: { athlete_id: athleteAId, valeur_kg: 74.5, date_mesure: new Date("2026-08-15") } });
      await prisma.weight_log.create({ data: { athlete_id: athleteBId, valeur_kg: 60.0, date_mesure: new Date("2026-08-10") } });

      const logs = await repository.findWeightLogsForAthletes([athleteAId, athleteBId]);
      const forA = logs.filter((l) => l.athlete_id === athleteAId);

      expect(logs).toHaveLength(3);
      expect(forA.map((l) => l.valeur_kg.toNumber())).toEqual([74.5, 74.0]);
    });

    it("ne renvoie que les objectifs actifs (actif=true)", async () => {
      const athleteId = await makeAthlete();
      await prisma.weight_target.create({ data: { athlete_id: athleteId, poids_cible_kg: 70, actif: false } });
      await prisma.weight_target.create({ data: { athlete_id: athleteId, poids_cible_kg: 74, actif: true } });

      const targets = await repository.findActiveWeightTargetsForAthletes([athleteId]);

      expect(targets).toHaveLength(1);
      expect(targets[0].poids_cible_kg.toNumber()).toBe(74);
    });
  });

  describe("findMeasurementsForAthletes", () => {
    it("trie par athlete_id, metric_type_id, mesure_le desc — permet de retrouver les 2 dernières mesures en mémoire", async () => {
      const athleteId = await makeAthlete();
      const metricType = await prisma.metric_type.findFirst();
      if (!metricType) throw new Error("Aucun metric_type en base pour ce test");

      await prisma.metric_measurement.create({
        data: { athlete_id: athleteId, metric_type_id: metricType.id, valeur: 10, mesure_le: new Date("2026-08-01") },
      });
      await prisma.metric_measurement.create({
        data: { athlete_id: athleteId, metric_type_id: metricType.id, valeur: 12, mesure_le: new Date("2026-08-15") },
      });

      const rows = await repository.findMeasurementsForAthletes([athleteId]);
      const forAthlete = rows.filter((r) => r.athlete_id === athleteId && r.metric_type_id === metricType.id);

      expect(forAthlete.map((r) => r.valeur.toNumber())).toEqual([12, 10]);
    });
  });

  describe("findUpcomingParticipationsForAthletes", () => {
    it("exclut les compétitions passées et les statuts inactifs (annule/retire)", async () => {
      const athleteId = await makeAthlete();
      const pastCompetitionId = await makeCompetition(-10);
      const futureCompetitionId = await makeCompetition(10);
      const cancelledCompetitionId = await makeCompetition(20);

      await prisma.participation.create({ data: { athlete_id: athleteId, competition_id: pastCompetitionId } });
      await prisma.participation.create({ data: { athlete_id: athleteId, competition_id: futureCompetitionId } });
      await prisma.participation.create({
        data: { athlete_id: athleteId, competition_id: cancelledCompetitionId, statut: "annule" },
      });

      const results = await repository.findUpcomingParticipationsForAthletes([athleteId], new Date());

      expect(results.map((r) => r.competition.id)).toEqual([futureCompetitionId]);
    });

    it("une compétition catalogue sans participation n'apparaît jamais (seules les participations réelles)", async () => {
      const athleteId = await makeAthlete();
      await makeCompetition(5); // aucune participation créée pour celle-ci

      const results = await repository.findUpcomingParticipationsForAthletes([athleteId], new Date());

      expect(results).toEqual([]);
    });
  });

  describe("findUpcomingTrainingsForAthletes", () => {
    it("exclut les séances annulées et celles déjà terminées", async () => {
      const athleteId = await makeAthlete();
      const now = new Date();
      await prisma.training_session.create({
        data: { athlete_id: athleteId, titre: "Passée", date_debut: new Date(now.getTime() - 86400000) },
      });
      await prisma.training_session.create({
        data: { athlete_id: athleteId, titre: "Future", date_debut: new Date(now.getTime() + 86400000) },
      });
      await prisma.training_session.create({
        data: { athlete_id: athleteId, titre: "Annulée", date_debut: new Date(now.getTime() + 172800000), statut: "annule" },
      });

      const results = await repository.findUpcomingTrainingsForAthletes([athleteId], now);

      expect(results.map((r) => r.titre)).toEqual(["Future"]);
    });
  });

  describe("findActiveGoalsForAthletes", () => {
    it("ne renvoie que les objectifs statut='en_cours'", async () => {
      const athleteId = await makeAthlete();
      await prisma.athlete_goal.create({ data: { athlete_id: athleteId, titre: "Terminé", statut: "termine" } });
      await prisma.athlete_goal.create({ data: { athlete_id: athleteId, titre: "En cours", statut: "en_cours" } });

      const results = await repository.findActiveGoalsForAthletes([athleteId]);

      expect(results.map((r) => r.titre)).toEqual(["En cours"]);
    });
  });
});
