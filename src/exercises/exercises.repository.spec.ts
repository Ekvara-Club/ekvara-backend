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
});
