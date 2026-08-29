import "dotenv/config";
import { ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CoachRepository } from "./coach.repository";
import { CoachGroupsRepository } from "./coach-groups.repository";
import { CoachDashboardRepository } from "./coach-dashboard.repository";
import { CoachDashboardService } from "./coach-dashboard.service";
import { MetricsRepository } from "../metrics/metrics.repository";
import { CoachTrainingsService } from "./coach-trainings.service";
import { CoachTrainingsRepository } from "./coach-trainings.repository";
import { CoachDestinataireResolver } from "./coach-destinataire-resolver";
import { CoachTrainingAttendanceService } from "./coach-training-attendance.service";
import { CoachTrainingAttendanceRepository } from "./coach-training-attendance.repository";
import { CoachCompetitionPreparationsRepository } from "./coach-competition-preparations.repository";
import { CoachGroupDashboardService } from "./coach-group-dashboard.service";

// Test d'intégration Postgres réelle (même convention que
// coach-training-attendance.spec.ts / coach-dashboard.performance.spec.ts) :
// fixtures jetables nettoyées via cascade sur app_user + suppression
// explicite des compétitions/metric_type créés (non liés à app_user).
// Couvre : ownership (403), groupe vide, formule attendance groupe exacte
// (ticket §61), séance annulée exclue (§62), snapshot vs membership actuel
// (§63-65), dédup compétitions (§66), compteurs préparation (§67), objectif
// en retard (§68), métrique en baisse — logique réutilisée (§69), non
// renseigné != absent.
describe("Dashboard groupe Coach V1 — intégration Postgres réelle", () => {
  let prisma: PrismaService;
  let trainingsService: CoachTrainingsService;
  let attendanceService: CoachTrainingAttendanceService;
  let groupDashboardService: CoachGroupDashboardService;
  const runId = Date.now();
  const createdUserIds: string[] = [];
  const createdCompetitionIds: string[] = [];
  const createdMetricTypeIds: string[] = [];
  let counter = 0;

  beforeAll(() => {
    prisma = new PrismaService();
    trainingsService = new CoachTrainingsService(new CoachTrainingsRepository(prisma), new CoachDestinataireResolver(prisma));
    attendanceService = new CoachTrainingAttendanceService(new CoachTrainingAttendanceRepository(prisma));
    const metricsRepository = new MetricsRepository(prisma);
    const dashboardService = new CoachDashboardService(
      new CoachRepository(prisma),
      new CoachGroupsRepository(prisma),
      new CoachDashboardRepository(prisma, metricsRepository),
    );
    groupDashboardService = new CoachGroupDashboardService(
      new CoachGroupsRepository(prisma),
      dashboardService,
      attendanceService,
      new CoachTrainingsRepository(prisma),
      new CoachCompetitionPreparationsRepository(prisma),
    );
  }, 30000);

  afterEach(async () => {
    if (createdCompetitionIds.length > 0) {
      await prisma.competition.deleteMany({ where: { id: { in: createdCompetitionIds } } });
      createdCompetitionIds.length = 0;
    }
    if (createdMetricTypeIds.length > 0) {
      await prisma.metric_type.deleteMany({ where: { id: { in: createdMetricTypeIds } } });
      createdMetricTypeIds.length = 0;
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
      data: { email: `test-groupdash-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `C${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return profile.id;
  }

  async function makeAthlete(prenom: string): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-groupdash-athlete-${runId}-${counter}@test.fr`, nom: "Test", prenom },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
    return athlete.id;
  }

  async function linkAthlete(coachId: string, athleteId: string): Promise<void> {
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteId } });
  }

  async function makeGroup(coachId: string, name: string): Promise<string> {
    counter += 1;
    const group = await prisma.coach_group.create({ data: { coach_id: coachId, name: `${name} ${runId}-${counter}` } });
    return group.id;
  }

  async function addToGroup(groupId: string, athleteId: string): Promise<void> {
    await prisma.coach_group_athlete.create({ data: { group_id: groupId, athlete_id: athleteId } });
  }

  async function removeFromGroup(groupId: string, athleteId: string): Promise<void> {
    await prisma.coach_group_athlete.delete({ where: { group_id_athlete_id: { group_id: groupId, athlete_id: athleteId } } });
  }

  function daysFromNow(n: number): string {
    return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
  }

  async function makeCompetition(nom: string, daysFromNowStart: number): Promise<string> {
    const competition = await prisma.competition.create({
      data: { nom: `${nom} ${runId}`, date_debut: new Date(Date.now() + daysFromNowStart * 24 * 60 * 60 * 1000) },
    });
    createdCompetitionIds.push(competition.id);
    return competition.id;
  }

  it("ownership : coach B sur le groupe de coach A -> ForbiddenException", async () => {
    const coachA = await makeCoach();
    const coachB = await makeCoach();
    const a = await makeAthlete("A");
    await linkAthlete(coachA, a);
    const groupId = await makeGroup(coachA, "Élite");
    await addToGroup(groupId, a);

    // Le service seul ne recoupe pas CoachGroupOwnershipGuard (vérifié au
    // niveau HTTP) : getGroupRosterComputed lève ForbiddenException en
    // défense, exactement le même mécanisme que resolveRoster (ticket §4).
    await expect(groupDashboardService.getGroupDashboard(coachB, groupId)).rejects.toBeInstanceOf(ForbiddenException);
  }, 30000);

  it("groupe vide : athleteCount=0, attendanceRate=null, athletes/attention/competitions=[]", async () => {
    const coachId = await makeCoach();
    const groupId = await makeGroup(coachId, "Vide");

    const result = await groupDashboardService.getGroupDashboard(coachId, groupId);

    expect(result.group.athleteCount).toBe(0);
    expect(result.attendance.last30Days.attendanceRate).toBeNull();
    expect(result.athletes).toEqual([]);
    expect(result.attention).toEqual([]);
    expect(result.competitions).toEqual([]);
  }, 30000);

  it("formule attendance groupe exacte (ticket §61) : 2 séances, A/B/C mixtes, non renseigné != absent", async () => {
    const coachId = await makeCoach();
    const a = await makeAthlete("A");
    const b = await makeAthlete("B");
    const c = await makeAthlete("C");
    await linkAthlete(coachId, a);
    await linkAthlete(coachId, b);
    await linkAthlete(coachId, c);
    const groupId = await makeGroup(coachId, "Élite61");
    await addToGroup(groupId, a);
    await addToGroup(groupId, b);
    await addToGroup(groupId, c);

    const s1 = await trainingsService.createTraining(coachId, { title: `S1 ${runId}`, startAt: daysFromNow(-2), groupIds: [groupId] });
    const s2 = await trainingsService.createTraining(coachId, { title: `S2 ${runId}`, startAt: daysFromNow(-1), groupIds: [groupId] });

    await attendanceService.putAttendance(s1.id, {
      attendances: [
        { athleteId: a, status: "present" },
        { athleteId: b, status: "absent" },
        // C non renseigné intentionnellement sur S1
      ],
    });
    await attendanceService.putAttendance(s2.id, {
      attendances: [
        { athleteId: a, status: "present" },
        { athleteId: b, status: "excuse" },
        { athleteId: c, status: "present" },
      ],
    });

    const result = await groupDashboardService.getGroupDashboard(coachId, groupId);

    expect(result.attendance.last30Days).toEqual({
      eligibleAttendances: 6, // 3 athlètes x 2 séances
      recordedAttendances: 5, // C-S1 non renseigné exclu
      present: 3,
      absent: 1,
      excused: 1,
      attendanceRate: 0.6,
    });
  }, 30000);

  it("séance annulée : totalement exclue des statistiques groupe (ticket §62)", async () => {
    const coachId = await makeCoach();
    const a = await makeAthlete("A");
    await linkAthlete(coachId, a);
    const groupId = await makeGroup(coachId, "Annulee");
    await addToGroup(groupId, a);

    const training = await trainingsService.createTraining(coachId, { title: `Annulée ${runId}`, startAt: daysFromNow(-1), groupIds: [groupId] });
    await attendanceService.putAttendance(training.id, { attendances: [{ athleteId: a, status: "present" }] });
    await trainingsService.cancel(training.id);

    const result = await groupDashboardService.getGroupDashboard(coachId, groupId);

    expect(result.attendance.last30Days.eligibleAttendances).toBe(0);
    expect(result.attendance.last30Days.attendanceRate).toBeNull();
    expect(result.training.completedSessionsLast30Days).toBe(0);
  }, 30000);

  it("snapshot vs membership actuel (ticket §63-65) : ancien membre compte dans l'historique, pas dans le roster actuel ; nouveau membre l'inverse", async () => {
    const coachId = await makeCoach();
    const a = await makeAthlete("A");
    const b = await makeAthlete("B");
    const c = await makeAthlete("C");
    const d = await makeAthlete("D");
    await linkAthlete(coachId, a);
    await linkAthlete(coachId, b);
    await linkAthlete(coachId, c);
    await linkAthlete(coachId, d);
    const groupId = await makeGroup(coachId, "Snapshot");
    await addToGroup(groupId, a);
    await addToGroup(groupId, b);
    await addToGroup(groupId, c); // composition au moment de la séance : A, B, C

    const training = await trainingsService.createTraining(coachId, { title: `Historique ${runId}`, startAt: daysFromNow(-1), groupIds: [groupId] });
    await attendanceService.putAttendance(training.id, {
      attendances: [
        { athleteId: a, status: "present" },
        { athleteId: b, status: "present" },
        { athleteId: c, status: "present" },
      ],
    });

    // Composition change APRÈS la séance : C retiré, D ajouté.
    await removeFromGroup(groupId, c);
    await addToGroup(groupId, d);

    const result = await groupDashboardService.getGroupDashboard(coachId, groupId);

    // Stats historiques : toujours 3 paires (A, B, C), D n'y contribue jamais.
    expect(result.attendance.last30Days.recordedAttendances).toBe(3);
    expect(result.attendance.last30Days.present).toBe(3);

    // Roster ACTUEL affiché : A, B, D — jamais C.
    const currentIds = result.athletes.map((x) => x.id).sort();
    expect(currentIds).toEqual([a, b, d].sort());
    expect(result.group.athleteCount).toBe(3);
  }, 30000);

  it("dédup compétitions (ticket §66) : deux athlètes sur la même compétition -> 1 compétition, athleteCount=2", async () => {
    const coachId = await makeCoach();
    const a = await makeAthlete("A");
    const b = await makeAthlete("B");
    await linkAthlete(coachId, a);
    await linkAthlete(coachId, b);
    const groupId = await makeGroup(coachId, "Compet");
    await addToGroup(groupId, a);
    await addToGroup(groupId, b);

    const competitionId = await makeCompetition("Paris 2026", 40);
    await prisma.participation.create({ data: { athlete_id: a, competition_id: competitionId, statut: "inscrit" } });
    await prisma.participation.create({ data: { athlete_id: b, competition_id: competitionId, statut: "inscrit" } });

    const result = await groupDashboardService.getGroupDashboard(coachId, groupId);

    expect(result.competitions).toHaveLength(1);
    expect(result.competitions[0].athleteCount).toBe(2);
  }, 30000);

  it("préparations (ticket §67) : compteurs par statut corrects, forfait -> attention", async () => {
    const coachId = await makeCoach();
    const a = await makeAthlete("A");
    const b = await makeAthlete("B");
    await linkAthlete(coachId, a);
    await linkAthlete(coachId, b);
    const groupId = await makeGroup(coachId, "Prepa");
    await addToGroup(groupId, a);
    await addToGroup(groupId, b);

    const competitionId = await makeCompetition("French Open", 20);
    await prisma.coach_competition_preparation.create({
      data: { coach_id: coachId, athlete_id: a, competition_id: competitionId, statut: "selectionne" },
    });
    await prisma.coach_competition_preparation.create({
      data: { coach_id: coachId, athlete_id: b, competition_id: competitionId, statut: "forfait" },
    });

    const result = await groupDashboardService.getGroupDashboard(coachId, groupId);

    expect(result.preparation.activeCount).toBe(2);
    expect(result.preparation.byStatus.selectionne).toBe(1);
    expect(result.preparation.byStatus.forfait).toBe(1);
    expect(result.preparation.byStatus.pret).toBeUndefined(); // jamais un statut absent à 0 (§15)

    const athleteB = result.athletes.find((x) => x.id === b)!;
    expect(athleteB.attentionReasons.some((r) => r.type === "PREPARATION_FORFAIT")).toBe(true);
    const athleteA = result.athletes.find((x) => x.id === a)!;
    expect(athleteA.attentionReasons.some((r) => r.type === "PREPARATION_FORFAIT")).toBe(false);
  }, 30000);

  it("objectif en retard (ticket §68) : date cible passée + en_cours -> attention ; objectif terminé -> pas d'attention", async () => {
    const coachId = await makeCoach();
    const a = await makeAthlete("A");
    const b = await makeAthlete("B");
    await linkAthlete(coachId, a);
    await linkAthlete(coachId, b);
    const groupId = await makeGroup(coachId, "Objectif");
    await addToGroup(groupId, a);
    await addToGroup(groupId, b);

    await prisma.athlete_goal.create({
      data: { athlete_id: a, titre: "Objectif en retard", date_cible: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), statut: "en_cours" },
    });
    await prisma.athlete_goal.create({
      data: { athlete_id: b, titre: "Objectif terminé", date_cible: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), statut: "atteint" },
    });

    const result = await groupDashboardService.getGroupDashboard(coachId, groupId);

    const athleteA = result.athletes.find((x) => x.id === a)!;
    expect(athleteA.attentionReasons.some((r) => r.type === "GOAL_OVERDUE")).toBe(true);
    const athleteB = result.athletes.find((x) => x.id === b)!;
    expect(athleteB.attentionReasons.some((r) => r.type === "GOAL_OVERDUE")).toBe(false);
  }, 30000);

  it("métrique en baisse (ticket §69) : réutilise la logique de progression existante -> METRIC_DECLINING", async () => {
    const coachId = await makeCoach();
    const a = await makeAthlete("A");
    await linkAthlete(coachId, a);
    const groupId = await makeGroup(coachId, "Metric");
    await addToGroup(groupId, a);

    counter += 1;
    const metricType = await prisma.metric_type.create({
      data: { code: `test-groupdash-${runId}-${counter}`, nom: "Vitesse test", improvement_direction: "higher" },
    });
    createdMetricTypeIds.push(metricType.id);

    await prisma.metric_measurement.create({
      data: { athlete_id: a, metric_type_id: metricType.id, valeur: 10, mesure_le: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
    });
    await prisma.metric_measurement.create({
      data: { athlete_id: a, metric_type_id: metricType.id, valeur: 8, mesure_le: new Date() }, // 10 -> 8, higher-is-better -> declined
    });

    const result = await groupDashboardService.getGroupDashboard(coachId, groupId);

    const athleteA = result.athletes.find((x) => x.id === a)!;
    expect(athleteA.attentionReasons.some((r) => r.type === "METRIC_DECLINING")).toBe(true);
    expect(athleteA.progression.decliningCount).toBeGreaterThan(0);
  }, 30000);

  it("assiduité faible (seuil validé §23) : recordedSessions >= 3 ET taux < 70% -> ATTENDANCE_LOW ; en dessous du seuil de volume -> pas d'attention", async () => {
    const coachId = await makeCoach();
    const a = await makeAthlete("A"); // 1 présence sur 1 -> pas assez de données, jamais ATTENDANCE_LOW
    const b = await makeAthlete("B"); // 1 présent / 3 -> 33%, assez de données -> ATTENDANCE_LOW
    await linkAthlete(coachId, a);
    await linkAthlete(coachId, b);
    const groupId = await makeGroup(coachId, "Assiduite");
    await addToGroup(groupId, a);
    await addToGroup(groupId, b);

    const sA = await trainingsService.createTraining(coachId, { title: `A1 ${runId}`, startAt: daysFromNow(-1), athleteIds: [a] });
    await attendanceService.putAttendance(sA.id, { attendances: [{ athleteId: a, status: "absent" }] });

    const sB1 = await trainingsService.createTraining(coachId, { title: `B1 ${runId}`, startAt: daysFromNow(-3), athleteIds: [b] });
    const sB2 = await trainingsService.createTraining(coachId, { title: `B2 ${runId}`, startAt: daysFromNow(-2), athleteIds: [b] });
    const sB3 = await trainingsService.createTraining(coachId, { title: `B3 ${runId}`, startAt: daysFromNow(-1), athleteIds: [b] });
    await attendanceService.putAttendance(sB1.id, { attendances: [{ athleteId: b, status: "present" }] });
    await attendanceService.putAttendance(sB2.id, { attendances: [{ athleteId: b, status: "absent" }] });
    await attendanceService.putAttendance(sB3.id, { attendances: [{ athleteId: b, status: "absent" }] });

    const result = await groupDashboardService.getGroupDashboard(coachId, groupId);

    const athleteA = result.athletes.find((x) => x.id === a)!;
    expect(athleteA.attendance30d.recordedSessions).toBe(1);
    expect(athleteA.attentionReasons.some((r) => r.type === "ATTENDANCE_LOW")).toBe(false);

    const athleteB = result.athletes.find((x) => x.id === b)!;
    expect(athleteB.attendance30d.recordedSessions).toBe(3);
    expect(athleteB.attendance30d.attendanceRate).toBeCloseTo(1 / 3);
    expect(athleteB.attentionReasons.some((r) => r.type === "ATTENDANCE_LOW")).toBe(true);
  }, 30000);

  it("cohérence AthleteDetail <-> GroupDetail (ticket §10) : même formule, mêmes chiffres pour le même athlète/période", async () => {
    const coachId = await makeCoach();
    const a = await makeAthlete("A");
    await linkAthlete(coachId, a);
    const groupId = await makeGroup(coachId, "Coherence");
    await addToGroup(groupId, a);

    const s1 = await trainingsService.createTraining(coachId, { title: `C1 ${runId}`, startAt: daysFromNow(-2), athleteIds: [a] });
    const s2 = await trainingsService.createTraining(coachId, { title: `C2 ${runId}`, startAt: daysFromNow(-1), athleteIds: [a] });
    await attendanceService.putAttendance(s1.id, { attendances: [{ athleteId: a, status: "present" }] });
    await attendanceService.putAttendance(s2.id, { attendances: [{ athleteId: a, status: "absent" }] });

    const athleteDetail = await attendanceService.getAthleteSummary(coachId, a);
    const result = await groupDashboardService.getGroupDashboard(coachId, groupId);
    const rowInGroup = result.athletes.find((x) => x.id === a)!;

    expect(rowInGroup.attendance30d.attendanceRate).toBe(athleteDetail.last30Days.attendanceRate);
    expect(rowInGroup.attendance30d.recordedSessions).toBe(athleteDetail.last30Days.recordedSessions);
    expect(rowInGroup.attendance30d.present).toBe(athleteDetail.last30Days.present);
  }, 30000);
});
