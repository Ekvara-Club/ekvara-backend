import "dotenv/config";
import { ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CoachExercisesService } from "./coach-exercises.service";
import { CoachExercisesRepository } from "./coach-exercises.repository";
import { CoachDestinataireResolver } from "./coach-destinataire-resolver";

// Test d'intégration contre la vraie base Postgres locale (ticket §25) :
// fixtures réalistes (coach + groupe Elite A/B/C + groupe Junior C/D +
// athlète E hors groupe + athlète X d'un autre coach), résolution de
// destinataires, rollback complet, snapshot de groupe, suppression de
// groupe, retrait coach_athlete, isolation coach A/B, suppression
// d'exercice, et idempotence RÉELLE au niveau service (double PUT
// identique). Fixtures jetables nettoyées en afterEach via cascade sur
// app_user.
describe("CoachExercisesService — fixtures réalistes (intégration Postgres)", () => {
  let prisma: PrismaService;
  const runId = Date.now();
  const createdUserIds: string[] = [];
  let counter = 0;

  beforeAll(() => {
    prisma = new PrismaService();
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

  function buildService(): CoachExercisesService {
    return new CoachExercisesService(new CoachExercisesRepository(prisma), new CoachDestinataireResolver(prisma));
  }

  async function makeCoach(): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-cexfx-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `F${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return profile.id;
  }

  async function makeAthlete(prenom: string): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-cexfx-athlete-${runId}-${counter}@test.fr`, nom: "Test", prenom },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
    return athlete.id;
  }

  it("Elite (A/B/C), Elite+Junior (A/B/C/D), Elite+E (A/B/C/E), X étranger -> rollback, groupe étranger -> rollback, snapshot, suppression groupe/exercice, retrait coach_athlete, isolation coach A/B, idempotence réelle", async () => {
    const coachId = await makeCoach();
    const otherCoachId = await makeCoach();

    const athleteA = await makeAthlete("A");
    const athleteB = await makeAthlete("B");
    const athleteC = await makeAthlete("C");
    const athleteD = await makeAthlete("D");
    const athleteE = await makeAthlete("E");
    const athleteX = await makeAthlete("X");

    for (const id of [athleteA, athleteB, athleteC, athleteD, athleteE]) {
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: id } });
    }
    await prisma.coach_athlete.create({ data: { coach_id: otherCoachId, athlete_id: athleteX } });

    const elite = await prisma.coach_group.create({ data: { coach_id: coachId, name: `Elite ${runId}` } });
    const junior = await prisma.coach_group.create({ data: { coach_id: coachId, name: `Junior ${runId}` } });
    for (const id of [athleteA, athleteB, athleteC]) {
      await prisma.coach_group_athlete.create({ data: { group_id: elite.id, athlete_id: id } });
    }
    for (const id of [athleteC, athleteD]) {
      await prisma.coach_group_athlete.create({ data: { group_id: junior.id, athlete_id: id } });
    }
    const foreignGroup = await prisma.coach_group.create({ data: { coach_id: otherCoachId, name: `Foreign ${runId}` } });

    const service = buildService();

    const exercise = await service.createExercise(coachId, { title: `Cut avant ${runId}` });

    // --- Elite seul -> A/B/C ---
    const p1 = await service.replaceAssignments(coachId, exercise.id, { groupIds: [elite.id], athleteIds: [] });
    expect(p1.assignments.athletes.map((a) => a.id).sort()).toEqual([athleteA, athleteB, athleteC].sort());

    // --- Elite + Junior -> union A/B/C/D ---
    const p2 = await service.replaceAssignments(coachId, exercise.id, { groupIds: [elite.id, junior.id], athleteIds: [] });
    expect(p2.assignments.athleteCount).toBe(4);
    expect(p2.assignments.athletes.map((a) => a.id).sort()).toEqual([athleteA, athleteB, athleteC, athleteD].sort());

    // --- Elite + E -> A/B/C/E ---
    const p3 = await service.replaceAssignments(coachId, exercise.id, { groupIds: [elite.id], athleteIds: [athleteE] });
    expect(p3.assignments.athletes.map((a) => a.id).sort()).toEqual([athleteA, athleteB, athleteC, athleteE].sort());

    // --- Idempotence RÉELLE (service, double PUT identique) ---
    const before = await prisma.coach_exercise_assignment.count({ where: { exercise_id: exercise.id } });
    const p3Again = await service.replaceAssignments(coachId, exercise.id, { groupIds: [elite.id], athleteIds: [athleteE] });
    const after = await prisma.coach_exercise_assignment.count({ where: { exercise_id: exercise.id } });
    expect(after).toBe(before);
    expect(p3Again.assignments.athletes.map((a) => a.id).sort()).toEqual(p3.assignments.athletes.map((a) => a.id).sort());

    // --- Destinataire non autorisé -> échec complet, rollback ---
    const assignmentsBefore = await prisma.coach_exercise_assignment.count({ where: { exercise_id: exercise.id } });
    await expect(
      service.replaceAssignments(coachId, exercise.id, { groupIds: [], athleteIds: [athleteX] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await prisma.coach_exercise_assignment.count({ where: { exercise_id: exercise.id } })).toBe(assignmentsBefore);

    // --- Groupe d'un autre coach -> échec complet, rollback ---
    await expect(
      service.replaceAssignments(coachId, exercise.id, { groupIds: [foreignGroup.id], athleteIds: [] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await prisma.coach_exercise_assignment.count({ where: { exercise_id: exercise.id } })).toBe(assignmentsBefore);
    expect(await prisma.coach_exercise_group_source.count({ where: { group_id: foreignGroup.id } })).toBe(0);

    // --- Snapshot groupe (ticket §12) : D rejoint Elite APRÈS coup, l'exercice publié via Elite seul ne le reçoit pas rétroactivement ---
    const snapshotExercise = await service.createExercise(coachId, { title: `Snapshot ${runId}` });
    await service.replaceAssignments(coachId, snapshotExercise.id, { groupIds: [elite.id], athleteIds: [] });
    await prisma.coach_group_athlete.create({ data: { group_id: elite.id, athlete_id: athleteD } });
    const unchanged = await service.findOneForCoach(snapshotExercise.id);
    expect(unchanged.assignments.athletes.map((a) => a.id).sort()).toEqual([athleteA, athleteB, athleteC].sort());
    // republish recalcule bien le snapshot :
    const republished = await service.replaceAssignments(coachId, snapshotExercise.id, { groupIds: [elite.id], athleteIds: [] });
    expect(republished.assignments.athletes.map((a) => a.id).sort()).toEqual(
      [athleteA, athleteB, athleteC, athleteD].sort(),
    );

    // --- Suppression du groupe : provenance disparaît, assignments restent ---
    await prisma.coach_group.delete({ where: { id: elite.id } });
    const afterGroupDeleted = await service.findOneForCoach(snapshotExercise.id);
    expect(afterGroupDeleted.assignments.athletes).toHaveLength(4); // toujours A/B/C/D
    expect(afterGroupDeleted.assignments.groups).toEqual([]);

    // --- Retrait coach_athlete : l'assignment déjà publiée reste ---
    await prisma.coach_athlete.delete({ where: { coach_id_athlete_id: { coach_id: coachId, athlete_id: athleteA } } });
    const afterAthleteRemoved = await service.findOneForCoach(snapshotExercise.id);
    expect(afterAthleteRemoved.assignments.athletes.map((a) => a.id)).toContain(athleteA);

    // --- Isolation coach A/B ---
    const otherCoachExercise = await service.createExercise(otherCoachId, { title: `Autre coach ${runId}` });
    const libraryForCoach = await service.findLibraryForCoach(coachId);
    expect(libraryForCoach.map((e) => e.id)).not.toContain(otherCoachExercise.id);

    // --- Suppression physique d'exercice ---
    await service.deleteExercise(exercise.id);
    expect(await prisma.exercise.findUnique({ where: { id: exercise.id } })).toBeNull();
  }, 30000);
});
