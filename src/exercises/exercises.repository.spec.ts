import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { ExercisesRepository } from "./exercises.repository";

// Test d'intégration contre la vraie base Postgres locale : le tri par titre et
// la forme exacte du select (aucun champ interne exposé) sont portés par la
// requête Prisma elle-même. Exercices jetables créés ici et nettoyés en
// afterAll — les exercices seedés pour le développement ne sont jamais touchés.
describe("ExercisesRepository (intégration Postgres)", () => {
  let prisma: PrismaService;
  let repository: ExercisesRepository;

  const runId = Date.now();
  const exerciseIds: string[] = [];

  const titreZ = `ZZZ Fixture Exercise ${runId}`;
  const titreA = `AAA Fixture Exercise ${runId}`;

  beforeAll(async () => {
    prisma = new PrismaService();
    repository = new ExercisesRepository(prisma);

    const z = await prisma.exercise.create({
      data: { titre: titreZ, type_exercice: "technique", niveau: "debutant" },
    });
    exerciseIds.push(z.id);

    const a = await prisma.exercise.create({
      data: { titre: titreA, type_exercice: "physique", niveau: "avance" },
    });
    exerciseIds.push(a.id);
  }, 30000);

  afterAll(async () => {
    await prisma.exercise.deleteMany({ where: { id: { in: exerciseIds } } });
    await prisma.$disconnect();
  }, 30000);

  it("findMany trie les exercices par titre croissant", async () => {
    const result = await repository.findMany();
    const fixtureTitles = result.map((e) => e.titre).filter((titre) => titre === titreA || titre === titreZ);

    expect(fixtureTitles).toEqual([titreA, titreZ]);
  });

  it("findMany ne retourne que les champs utiles (pas de created_at/updated_at)", async () => {
    const result = await repository.findMany();
    const fixture = result.find((e) => e.titre === titreA);

    expect(fixture).toBeDefined();
    expect(Object.keys(fixture as object).sort()).toEqual(
      ["id", "titre", "type_exercice", "panel_technique", "niveau", "description", "video_url", "gratuit"].sort(),
    );
  });

  it("findById retourne l'exercice quand il existe", async () => {
    const result = await repository.findById(exerciseIds[0]);

    expect(result?.titre).toBe(titreZ);
  });

  it("findById retourne null quand l'exercice n'existe pas", async () => {
    const result = await repository.findById("00000000-0000-4000-8000-000000000000");

    expect(result).toBeNull();
  });

  // ticket "Bibliothèque d'exercices Coach" §26 : visibilité athlète, contre
  // la vraie base — G = global, X = coach assigné à A, Y = coach assigné à
  // B. Fixtures jetables (coach + 2 athlètes) nettoyées ici, séparément des
  // exercices seedés pour le développement.
  describe("visibilité athlète (exercices coach)", () => {
    const createdUserIds: string[] = [];
    const coachExerciseIds: string[] = [];

    afterEach(async () => {
      if (coachExerciseIds.length > 0) {
        await prisma.exercise.deleteMany({ where: { id: { in: coachExerciseIds } } });
        coachExerciseIds.length = 0;
      }
      if (createdUserIds.length > 0) {
        await prisma.app_user.deleteMany({ where: { id: { in: createdUserIds } } });
        createdUserIds.length = 0;
      }
    });

    async function makeCoach(): Promise<string> {
      const user = await prisma.app_user.create({
        data: { email: `test-fixture-ex-coach-${runId}-${Date.now()}-${Math.random()}@test.fr`, nom: "Coach", prenom: "F" },
      });
      createdUserIds.push(user.id);
      const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
      return profile.id;
    }

    async function makeAthlete(): Promise<string> {
      const user = await prisma.app_user.create({
        data: { email: `test-fixture-ex-athlete-${runId}-${Date.now()}-${Math.random()}@test.fr`, nom: "N", prenom: "P" },
      });
      createdUserIds.push(user.id);
      const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
      return athlete.id;
    }

    it("G visible par A et B ; X (assigné à A) visible par A seulement ; Y (assigné à B) visible par B seulement", async () => {
      const coachId = await makeCoach();
      const athleteA = await makeAthlete();
      const athleteB = await makeAthlete();

      const x = await prisma.exercise.create({
        data: { titre: `X coach ${runId}`, created_by_coach_id: coachId },
      });
      coachExerciseIds.push(x.id);
      await prisma.coach_exercise_assignment.create({ data: { exercise_id: x.id, athlete_id: athleteA } });

      const y = await prisma.exercise.create({
        data: { titre: `Y coach ${runId}`, created_by_coach_id: coachId },
      });
      coachExerciseIds.push(y.id);
      await prisma.coach_exercise_assignment.create({ data: { exercise_id: y.id, athlete_id: athleteB } });

      const forA = await repository.findMany(athleteA);
      const forB = await repository.findMany(athleteB);

      const titlesForA = forA.map((e) => e.titre);
      const titlesForB = forB.map((e) => e.titre);

      expect(titlesForA).toContain(titreA); // globaux toujours visibles
      expect(titlesForA).toContain(`X coach ${runId}`);
      expect(titlesForA).not.toContain(`Y coach ${runId}`);

      expect(titlesForB).toContain(titreA);
      expect(titlesForB).toContain(`Y coach ${runId}`);
      expect(titlesForB).not.toContain(`X coach ${runId}`);
    });

    it("athlète sans aucune publication -> uniquement les exercices globaux", async () => {
      const coachId = await makeCoach();
      const athleteC = await makeAthlete();
      const x = await prisma.exercise.create({ data: { titre: `X isolé ${runId}`, created_by_coach_id: coachId } });
      coachExerciseIds.push(x.id);
      // Pas d'assignment pour athleteC.

      const result = await repository.findMany(athleteC);

      expect(result.map((e) => e.titre)).not.toContain(`X isolé ${runId}`);
      expect(result.map((e) => e.titre)).toContain(titreA); // toujours les globaux
    });

    it("findById respecte la même visibilité : X inaccessible en detail pour un athlète non assigné", async () => {
      const coachId = await makeCoach();
      const athleteA = await makeAthlete();
      const athleteOther = await makeAthlete();
      const x = await prisma.exercise.create({ data: { titre: `X detail ${runId}`, created_by_coach_id: coachId } });
      coachExerciseIds.push(x.id);
      await prisma.coach_exercise_assignment.create({ data: { exercise_id: x.id, athlete_id: athleteA } });

      expect((await repository.findById(x.id, athleteA))?.titre).toBe(`X detail ${runId}`);
      expect(await repository.findById(x.id, athleteOther)).toBeNull();
    });

    it("coach-only (athleteId absent) -> ne voit jamais un exercice coach, uniquement les globaux", async () => {
      const coachId = await makeCoach();
      const x = await prisma.exercise.create({ data: { titre: `X coach-only ${runId}`, created_by_coach_id: coachId } });
      coachExerciseIds.push(x.id);

      const result = await repository.findMany(undefined);

      expect(result.map((e) => e.titre)).not.toContain(`X coach-only ${runId}`);
      expect(result.map((e) => e.titre)).toContain(titreA);
    });
  });
});
