import "dotenv/config";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CoachTrainingsService } from "./coach-trainings.service";
import { CoachTrainingsRepository } from "./coach-trainings.repository";
import { CoachDestinataireResolver } from "./coach-destinataire-resolver";
import { NotificationsRepository } from "../notifications/notifications.repository";
import { CoachTrainingAttendanceService } from "./coach-training-attendance.service";
import { CoachTrainingAttendanceRepository } from "./coach-training-attendance.repository";

// Test d'intégration Postgres réelle (même convention que
// coach-trainings.fixture.spec.ts / competitions.repository.spec.ts) :
// fixtures jetables nettoyées via cascade sur app_user en afterEach. Couvre
// batch create/update, athlète non assigné, snapshot (dérive de groupe
// post-publication), séance annulée (résumé + PUT bloqué), séance future
// (PUT bloqué), retrait roster (historique conservé), non renseigné != absent,
// blocage retrait d'assignation avec présence déjà enregistrée (ticket §3),
// isolation multi-coach sur le résumé assiduité.
describe("Présences Coach V1 — intégration Postgres réelle", () => {
  let prisma: PrismaService;
  let trainingsService: CoachTrainingsService;
  let attendanceService: CoachTrainingAttendanceService;
  const runId = Date.now();
  const createdUserIds: string[] = [];
  let counter = 0;

  beforeAll(() => {
    prisma = new PrismaService();
    trainingsService = new CoachTrainingsService(
      new CoachTrainingsRepository(prisma, new NotificationsRepository(prisma)),
      new CoachDestinataireResolver(prisma),
    );
    attendanceService = new CoachTrainingAttendanceService(new CoachTrainingAttendanceRepository(prisma));
  }, 30000);

  afterEach(async () => {
    if (createdUserIds.length > 0) {
      await prisma.app_user.deleteMany({ where: { id: { in: createdUserIds } } });
      createdUserIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  }, 30000);

  async function makeCoach(): Promise<{ coachId: string; userId: string }> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-attendance-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `C${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return { coachId: profile.id, userId: user.id };
  }

  async function makeAthlete(prenom: string): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-attendance-athlete-${runId}-${counter}@test.fr`, nom: "Test", prenom },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
    return athlete.id;
  }

  async function linkAthlete(coachId: string, athleteId: string): Promise<void> {
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteId } });
  }

  async function makeGroup(coachId: string, name: string): Promise<string> {
    const group = await prisma.coach_group.create({ data: { coach_id: coachId, name: `${name} ${runId}-${counter++}` } });
    return group.id;
  }

  function daysFromNow(n: number): string {
    return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
  }

  it("PUT batch initial, GET reflète, PUT à nouveau -> update pas duplicate", async () => {
    const { coachId, userId: actorUserId } = await makeCoach();
    const a = await makeAthlete("A");
    const b = await makeAthlete("B");
    const c = await makeAthlete("C");
    await linkAthlete(coachId, a);
    await linkAthlete(coachId, b);
    await linkAthlete(coachId, c);

    const training = await trainingsService.createTraining(coachId, actorUserId, {
      title: `Séance batch ${runId}`,
      startAt: daysFromNow(-1),
      athleteIds: [a, b, c],
    });

    const putResult = await attendanceService.putAttendance(training.id, {
      attendances: [
        { athleteId: a, status: "present" },
        { athleteId: b, status: "absent" },
        { athleteId: c, status: "excuse", note: "Stage équipe de France" },
      ],
    });
    expect(putResult.athletes.find((x) => x.athleteId === a)!.attendance!.status).toBe("present");
    expect(putResult.athletes.find((x) => x.athleteId === b)!.attendance!.status).toBe("absent");
    expect(putResult.athletes.find((x) => x.athleteId === c)!.attendance!.status).toBe("excuse");
    expect(putResult.athletes.find((x) => x.athleteId === c)!.attendance!.note).toBe("Stage équipe de France");

    const getResult = await attendanceService.getAttendanceSheet(training.id);
    expect(getResult.athletes.find((x) => x.athleteId === a)!.attendance!.status).toBe("present");

    const rowCountBefore = await prisma.training_attendance.count({ where: { athlete_id: { in: [a, b, c] } } });
    expect(rowCountBefore).toBe(3);

    // Re-PUT : B present au lieu d'absent -> update de la même ligne, pas de doublon.
    await attendanceService.putAttendance(training.id, {
      attendances: [{ athleteId: b, status: "present" }],
    });
    const rowCountAfter = await prisma.training_attendance.count({ where: { athlete_id: { in: [a, b, c] } } });
    expect(rowCountAfter).toBe(3);
    const bRow = await prisma.training_attendance.findFirst({ where: { athlete_id: b } });
    expect(bRow!.status).toBe("present");
  }, 30000);

  it("athlète non assigné à CETTE séance (même dans le roster) -> 400, aucune ligne créée", async () => {
    const { coachId, userId: actorUserId } = await makeCoach();
    const a = await makeAthlete("A");
    const outsider = await makeAthlete("Outsider");
    await linkAthlete(coachId, a);
    await linkAthlete(coachId, outsider); // dans le roster général du coach...

    const training = await trainingsService.createTraining(coachId, actorUserId, {
      title: `Séance restreinte ${runId}`,
      startAt: daysFromNow(-1),
      athleteIds: [a], // ...mais PAS assigné à cette séance précise
    });

    await expect(
      attendanceService.putAttendance(training.id, {
        attendances: [
          { athleteId: a, status: "present" },
          { athleteId: outsider, status: "present" },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const outsiderAttendance = await prisma.training_attendance.findFirst({ where: { athlete_id: outsider } });
    expect(outsiderAttendance).toBeNull();
    const aAttendance = await prisma.training_attendance.findFirst({ where: { athlete_id: a } });
    expect(aAttendance).toBeNull(); // échec complet, rien n'est appliqué partiellement
  }, 30000);

  it("dédoublonnage multi-groupe : athlète accessible via 2 groupes + individuel -> une seule ligne de présence", async () => {
    const { coachId, userId: actorUserId } = await makeCoach();
    const a = await makeAthlete("MultiGroup");
    await linkAthlete(coachId, a);
    const g1 = await makeGroup(coachId, "G1");
    const g2 = await makeGroup(coachId, "G2");
    await prisma.coach_group_athlete.create({ data: { group_id: g1, athlete_id: a } });
    await prisma.coach_group_athlete.create({ data: { group_id: g2, athlete_id: a } });

    const training = await trainingsService.createTraining(coachId, actorUserId, {
      title: `Séance multi-groupe ${runId}`,
      startAt: daysFromNow(-1),
      groupIds: [g1, g2],
      athleteIds: [a],
    });
    expect(training.assignments.athleteCount).toBe(1);

    await attendanceService.putAttendance(training.id, { attendances: [{ athleteId: a, status: "present" }] });
    const rows = await prisma.training_attendance.count({ where: { athlete_id: a } });
    expect(rows).toBe(1);
  }, 30000);

  it("snapshot : dérive de composition de groupe après publication ne change pas le roster de présence", async () => {
    const { coachId, userId: actorUserId } = await makeCoach();
    const a = await makeAthlete("SnapA");
    const b = await makeAthlete("SnapB");
    const cJoinsLater = await makeAthlete("SnapC");
    await linkAthlete(coachId, a);
    await linkAthlete(coachId, b);
    await linkAthlete(coachId, cJoinsLater);
    const group = await makeGroup(coachId, "Snap");
    await prisma.coach_group_athlete.create({ data: { group_id: group, athlete_id: a } });
    await prisma.coach_group_athlete.create({ data: { group_id: group, athlete_id: b } });

    const training = await trainingsService.createTraining(coachId, actorUserId, {
      title: `Séance snapshot ${runId}`,
      startAt: daysFromNow(-1),
      groupIds: [group],
    });

    // C rejoint le groupe APRÈS publication.
    await prisma.coach_group_athlete.create({ data: { group_id: group, athlete_id: cJoinsLater } });

    const sheet = await attendanceService.getAttendanceSheet(training.id);
    expect(sheet.athletes.map((x) => x.athleteId).sort()).toEqual([a, b].sort());
    expect(sheet.athletes.some((x) => x.athleteId === cJoinsLater)).toBe(false);

    // Le libellé de groupe snapshotté est bien présent pour A et B.
    expect(sheet.athletes.every((x) => x.groupName !== null)).toBe(true);
  }, 30000);

  it("séance annulée : exclue du résumé, PUT présence refusé (409)", async () => {
    const { coachId, userId: actorUserId } = await makeCoach();
    const a = await makeAthlete("Cancelled");
    await linkAthlete(coachId, a);

    const training = await trainingsService.createTraining(coachId, actorUserId, {
      title: `Séance annulée ${runId}`,
      startAt: daysFromNow(-1),
      athleteIds: [a],
    });
    await attendanceService.putAttendance(training.id, { attendances: [{ athleteId: a, status: "present" }] });

    await trainingsService.cancel(training.id, actorUserId);

    await expect(
      attendanceService.putAttendance(training.id, { attendances: [{ athleteId: a, status: "absent" }] }),
    ).rejects.toBeInstanceOf(ConflictException);

    const summary = await attendanceService.getAthleteSummary(coachId, a);
    expect(summary.last30Days.eligibleSessions).toBe(0);
    expect(summary.last30Days.recordedSessions).toBe(0);
  }, 30000);

  it("séance future : PUT présence refusé (409), GET reste accessible", async () => {
    const { coachId, userId: actorUserId } = await makeCoach();
    const a = await makeAthlete("Future");
    await linkAthlete(coachId, a);

    const training = await trainingsService.createTraining(coachId, actorUserId, {
      title: `Séance future ${runId}`,
      startAt: daysFromNow(10),
      athleteIds: [a],
    });

    await expect(
      attendanceService.putAttendance(training.id, { attendances: [{ athleteId: a, status: "present" }] }),
    ).rejects.toBeInstanceOf(ConflictException);

    const sheet = await attendanceService.getAttendanceSheet(training.id);
    expect(sheet.athletes[0].attendance).toBeNull();
  }, 30000);

  it("retrait du roster (unlink coach_athlete) : l'historique de présence n'est pas cascade-supprimé", async () => {
    const { coachId, userId: actorUserId } = await makeCoach();
    const a = await makeAthlete("Unlinked");
    await linkAthlete(coachId, a);

    const training = await trainingsService.createTraining(coachId, actorUserId, {
      title: `Séance avant retrait roster ${runId}`,
      startAt: daysFromNow(-1),
      athleteIds: [a],
    });
    await attendanceService.putAttendance(training.id, { attendances: [{ athleteId: a, status: "present" }] });

    await prisma.coach_athlete.deleteMany({ where: { coach_id: coachId, athlete_id: a } });

    const attendanceRow = await prisma.training_attendance.findFirst({ where: { athlete_id: a } });
    expect(attendanceRow).not.toBeNull();
    expect(attendanceRow!.status).toBe("present");
    const assignmentRow = await prisma.coach_training_assignment.findFirst({ where: { athlete_id: a } });
    expect(assignmentRow).not.toBeNull();
  }, 30000);

  it("non renseigné != absent : résumé distingue eligibleSessions et recordedSessions", async () => {
    const { coachId, userId: actorUserId } = await makeCoach();
    const a = await makeAthlete("Summary");
    await linkAthlete(coachId, a);

    const t1 = await trainingsService.createTraining(coachId, actorUserId, { title: `S1 ${runId}`, startAt: daysFromNow(-5), athleteIds: [a] });
    const t2 = await trainingsService.createTraining(coachId, actorUserId, { title: `S2 ${runId}`, startAt: daysFromNow(-3), athleteIds: [a] });
    await trainingsService.createTraining(coachId, actorUserId, { title: `S3 non renseignée ${runId}`, startAt: daysFromNow(-1), athleteIds: [a] });

    await attendanceService.putAttendance(t1.id, { attendances: [{ athleteId: a, status: "present" }] });
    await attendanceService.putAttendance(t2.id, { attendances: [{ athleteId: a, status: "absent" }] });
    // t3 : jamais renseignée.

    const summary = await attendanceService.getAthleteSummary(coachId, a);
    expect(summary.last30Days.eligibleSessions).toBe(3);
    expect(summary.last30Days.recordedSessions).toBe(2);
    expect(summary.last30Days.present).toBe(1);
    expect(summary.last30Days.absent).toBe(1);
    expect(summary.last30Days.excused).toBe(0);
    // Taux = present / recordedSessions (2), jamais / eligibleSessions (3) : 0.5, pas 0.33.
    expect(summary.last30Days.attendanceRate).toBe(0.5);
  }, 30000);

  it("retrait d'assignation avec présence déjà enregistrée -> 409, rien n'est modifié (whole-request-reject, même mélangé à un ajout/retrait valides)", async () => {
    const { coachId, userId: actorUserId } = await makeCoach();
    const a = await makeAthlete("Protected");
    const b = await makeAthlete("Removable");
    const c = await makeAthlete("ToAdd");
    await linkAthlete(coachId, a);
    await linkAthlete(coachId, b);
    await linkAthlete(coachId, c);

    const training = await trainingsService.createTraining(coachId, actorUserId, {
      title: `Séance protégée ${runId}`,
      startAt: daysFromNow(-1),
      athleteIds: [a, b],
    });
    await attendanceService.putAttendance(training.id, { attendances: [{ athleteId: a, status: "present" }] });

    // Nouvel ensemble demandé : uniquement C -> retire A (protégé, présence
    // enregistrée) ET B (non protégé), ajoute C. Le retrait de A doit
    // rejeter TOUTE la requête, y compris le retrait de B et l'ajout de C.
    await expect(
      trainingsService.replaceAssignments(coachId, actorUserId, training.id, { groupIds: [], athleteIds: [c] }),
    ).rejects.toBeInstanceOf(ConflictException);

    const detail = await trainingsService.findOneForCoach(training.id);
    expect(detail.assignments.athletes.map((x) => x.id).sort()).toEqual([a, b].sort());
    expect(detail.assignments.athletes.some((x) => x.id === c)).toBe(false);
    const attendanceStillThere = await prisma.training_attendance.findFirst({ where: { athlete_id: a } });
    expect(attendanceStillThere).not.toBeNull();
  }, 30000);

  it("isolation multi-coach : le résumé assiduité d'un coach n'inclut jamais les séances d'un autre coach sur le même athlète partagé", async () => {
    const { coachId: coachA, userId: actorUserIdA } = await makeCoach();
    const { coachId: coachB, userId: actorUserIdB } = await makeCoach();
    const shared = await makeAthlete("Shared");
    await linkAthlete(coachA, shared);
    await linkAthlete(coachB, shared);

    const trainingA = await trainingsService.createTraining(coachA, actorUserIdA, {
      title: `Séance coach A ${runId}`,
      startAt: daysFromNow(-1),
      athleteIds: [shared],
    });
    const trainingB = await trainingsService.createTraining(coachB, actorUserIdB, {
      title: `Séance coach B ${runId}`,
      startAt: daysFromNow(-2),
      athleteIds: [shared],
    });
    await attendanceService.putAttendance(trainingA.id, { attendances: [{ athleteId: shared, status: "present" }] });
    await attendanceService.putAttendance(trainingB.id, { attendances: [{ athleteId: shared, status: "absent" }] });

    const summaryA = await attendanceService.getAthleteSummary(coachA, shared);
    expect(summaryA.last30Days.eligibleSessions).toBe(1);
    expect(summaryA.last30Days.present).toBe(1);
    expect(summaryA.last30Days.absent).toBe(0);

    const summaryB = await attendanceService.getAthleteSummary(coachB, shared);
    expect(summaryB.last30Days.eligibleSessions).toBe(1);
    expect(summaryB.last30Days.present).toBe(0);
    expect(summaryB.last30Days.absent).toBe(1);
  }, 30000);
});
