import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { CoachExercisesRepository, ExerciseFieldsSnapshot } from "./coach-exercises.repository";

// Test d'intégration contre la vraie base Postgres locale : create/update/
// delete/replaceAssignments dépendent de comportements Postgres réels
// (cascade, contraintes uniques, transaction). Fixtures jetables nettoyées
// en afterEach via cascade sur app_user (les exercices coach eux-mêmes
// cascadent depuis coach_profile).
describe("CoachExercisesRepository (intégration Postgres)", () => {
  let prisma: PrismaService;
  let repository: CoachExercisesRepository;
  const runId = Date.now();
  const createdUserIds: string[] = [];
  let counter = 0;

  beforeAll(() => {
    prisma = new PrismaService();
    repository = new CoachExercisesRepository(prisma);
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

  async function makeCoach(): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-cex-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `F${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return profile.id;
  }

  async function makeAthlete(): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-cex-athlete-${runId}-${counter}@test.fr`, nom: `N${counter}`, prenom: `P${counter}` },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
    return athlete.id;
  }

  function fields(overrides: Partial<ExerciseFieldsSnapshot> = {}): ExerciseFieldsSnapshot {
    return { titre: `Exercice ${runId}`, ...overrides };
  }

  describe("create / findDetail / findLibraryForCoach", () => {
    it("crée l'exercice avec created_by_coach_id renseigné, retrouvable en bibliothèque coach", async () => {
      const coachId = await makeCoach();
      const exerciseId = await repository.create(coachId, fields());

      const library = await repository.findLibraryForCoach(coachId);
      expect(library.map((e) => e.id)).toContain(exerciseId);

      const raw = await prisma.exercise.findUnique({ where: { id: exerciseId } });
      expect(raw?.created_by_coach_id).toBe(coachId);
    });

    it("findLibraryForCoach isole strictement par coach", async () => {
      const coachA = await makeCoach();
      const coachB = await makeCoach();
      await repository.create(coachA, fields({ titre: `A ${runId}` }));
      await repository.create(coachB, fields({ titre: `B ${runId}` }));

      const libraryA = await repository.findLibraryForCoach(coachA);
      expect(libraryA.map((e) => e.titre)).toEqual([`A ${runId}`]);
    });

    it("findLibraryForCoach expose athleteCount et groups depuis les assignments/group_sources réels", async () => {
      const coachId = await makeCoach();
      const athleteId = await makeAthlete();
      const group = await prisma.coach_group.create({ data: { coach_id: coachId, name: `G ${runId}` } });
      const exerciseId = await repository.create(coachId, fields());
      await prisma.coach_exercise_assignment.create({ data: { exercise_id: exerciseId, athlete_id: athleteId } });
      await prisma.coach_exercise_group_source.create({ data: { exercise_id: exerciseId, group_id: group.id } });

      const [row] = await repository.findLibraryForCoach(coachId);
      expect(row._count.coach_exercise_assignment).toBe(1);
      expect(row.coach_exercise_group_source.map((s) => s.coach_group.id)).toEqual([group.id]);
    });
  });

  describe("update — une seule ligne partagée, aucune propagation nécessaire", () => {
    it("la modification est immédiatement visible via findDetail (pas de duplication)", async () => {
      const coachId = await makeCoach();
      const exerciseId = await repository.create(coachId, fields({ titre: "Avant" }));

      await repository.update(exerciseId, { titre: "Après" });

      const detail = await repository.findDetail(exerciseId);
      expect(detail?.titre).toBe("Après");
      // Une seule ligne exercise existe pour cet id (par construction FK/PK) :
      // aucune duplication possible par athlète.
    });
  });

  describe("delete — suppression physique", () => {
    it("supprime l'exercice ET ses assignments/group_sources (cascade)", async () => {
      const coachId = await makeCoach();
      const athleteId = await makeAthlete();
      const group = await prisma.coach_group.create({ data: { coach_id: coachId, name: `G ${runId}` } });
      const exerciseId = await repository.create(coachId, fields());
      await prisma.coach_exercise_assignment.create({ data: { exercise_id: exerciseId, athlete_id: athleteId } });
      await prisma.coach_exercise_group_source.create({ data: { exercise_id: exerciseId, group_id: group.id } });

      await repository.delete(exerciseId);

      expect(await prisma.exercise.findUnique({ where: { id: exerciseId } })).toBeNull();
      expect(await prisma.coach_exercise_assignment.findMany({ where: { exercise_id: exerciseId } })).toEqual([]);
      expect(await prisma.coach_exercise_group_source.findMany({ where: { exercise_id: exerciseId } })).toEqual([]);
    });
  });

  describe("replaceAssignments", () => {
    it("ajoute/retire des athlètes et remplace intégralement les group_sources", async () => {
      const coachId = await makeCoach();
      const athleteA = await makeAthlete();
      const athleteB = await makeAthlete();
      const athleteC = await makeAthlete();
      const groupA = await prisma.coach_group.create({ data: { coach_id: coachId, name: `GA ${runId}` } });
      const groupB = await prisma.coach_group.create({ data: { coach_id: coachId, name: `GB ${runId}` } });
      const exerciseId = await repository.create(coachId, fields());
      await repository.replaceAssignments(exerciseId, [athleteA, athleteB], [], [groupA.id]);

      await repository.replaceAssignments(exerciseId, [athleteC], [athleteB], [groupB.id]);

      const current = await repository.findCurrentAssignments(exerciseId);
      expect(current.map((a) => a.athlete_id).sort()).toEqual([athleteA, athleteC].sort());
      const sources = await prisma.coach_exercise_group_source.findMany({ where: { exercise_id: exerciseId } });
      expect(sources.map((s) => s.group_id)).toEqual([groupB.id]);
    });

    it("skipDuplicates protège même un appel direct avec un toAdd déjà assigné (défense en profondeur, ticket §22)", async () => {
      // L'idempotence "normale" est garantie par CoachExercisesService (diff
      // contre l'état courant avant d'appeler ici, voir
      // coach-exercises.service.spec.ts) — ce test vérifie le filet de
      // sécurité au niveau repository si jamais un appelant transmettait un
      // toAdd non diffé (ex. requête concurrente).
      const coachId = await makeCoach();
      const athleteA = await makeAthlete();
      const exerciseId = await repository.create(coachId, fields());

      await repository.replaceAssignments(exerciseId, [athleteA], [], []);
      await expect(repository.replaceAssignments(exerciseId, [athleteA], [], [])).resolves.not.toThrow();

      const current = await repository.findCurrentAssignments(exerciseId);
      expect(current).toHaveLength(1);
    });
  });

  describe("suppression d'un groupe (ticket §18)", () => {
    it("supprime uniquement la provenance, jamais l'exercice ni les assignments", async () => {
      const coachId = await makeCoach();
      const athleteA = await makeAthlete();
      const group = await prisma.coach_group.create({ data: { coach_id: coachId, name: `G ${runId}` } });
      const exerciseId = await repository.create(coachId, fields());
      await repository.replaceAssignments(exerciseId, [athleteA], [], [group.id]);

      await prisma.coach_group.delete({ where: { id: group.id } });

      const detail = await repository.findDetail(exerciseId);
      expect(detail).not.toBeNull();
      expect(detail?.coach_exercise_assignment).toHaveLength(1);
      expect(detail?.coach_exercise_group_source).toEqual([]);
    });
  });

  describe("retrait coach_athlete (ticket §19)", () => {
    it("ne cascade jamais sur l'assignment déjà publiée", async () => {
      const coachId = await makeCoach();
      const athleteA = await makeAthlete();
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteA } });
      const exerciseId = await repository.create(coachId, fields());
      await repository.replaceAssignments(exerciseId, [athleteA], [], []);

      await prisma.coach_athlete.delete({
        where: { coach_id_athlete_id: { coach_id: coachId, athlete_id: athleteA } },
      });

      const current = await repository.findCurrentAssignments(exerciseId);
      expect(current.map((a) => a.athlete_id)).toEqual([athleteA]);
    });
  });
});
