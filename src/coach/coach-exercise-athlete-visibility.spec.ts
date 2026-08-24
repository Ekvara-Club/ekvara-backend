import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { ExercisesService } from "../exercises/exercises.service";
import { ExercisesRepository } from "../exercises/exercises.repository";
import { CoachExercisesService } from "./coach-exercises.service";
import { CoachExercisesRepository } from "./coach-exercises.repository";
import { CoachDestinataireResolver } from "./coach-destinataire-resolver";

// LE test le plus important de ce ticket (voir ticket §26, même principe que
// coach-training-athlete-planning.spec.ts en ticket #3) : la publication
// d'un exercice coach doit être visible en passant EXCLUSIVEMENT par le VRAI
// ExercisesService/ExercisesRepository athlete-facing — jamais un chemin
// spécial coach-aware. G = exercice global, X = publié à A, Y = publié à B.
describe("Non-régression : visibilité athlète après publication coach (intégration Postgres)", () => {
  let prisma: PrismaService;
  let coachExercisesService: CoachExercisesService;
  let exercisesService: ExercisesService; // service ATHLETE-FACING réel, non modifié dans sa forme (juste étendu à athleteId optionnel)
  const runId = Date.now();
  const createdUserIds: string[] = [];
  const createdExerciseIds: string[] = [];
  let counter = 0;

  beforeAll(() => {
    prisma = new PrismaService();
    coachExercisesService = new CoachExercisesService(
      new CoachExercisesRepository(prisma),
      new CoachDestinataireResolver(prisma),
    );
    exercisesService = new ExercisesService(new ExercisesRepository(prisma));
  }, 30000);

  afterEach(async () => {
    if (createdExerciseIds.length > 0) {
      await prisma.exercise.deleteMany({ where: { id: { in: createdExerciseIds } } });
      createdExerciseIds.length = 0;
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
      data: { email: `test-fixture-exvis-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `F${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return profile.id;
  }

  async function makeAthlete(prenom: string): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-exvis-athlete-${runId}-${counter}@test.fr`, nom: "Test", prenom },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
    return athlete.id;
  }

  it("G global visible par A et B ; X publié à A absent pour B ; Y publié à B absent pour A", async () => {
    const coachId = await makeCoach();
    const athleteA = await makeAthlete("A");
    const athleteB = await makeAthlete("B");
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteA } });
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteB } });

    const globalExercise = await prisma.exercise.create({ data: { titre: `G global ${runId}` } });
    createdExerciseIds.push(globalExercise.id);

    const x = await coachExercisesService.createExercise(coachId, { title: `X publié A ${runId}` });
    createdExerciseIds.push(x.id);
    await coachExercisesService.replaceAssignments(coachId, x.id, { groupIds: [], athleteIds: [athleteA] });

    const y = await coachExercisesService.createExercise(coachId, { title: `Y publié B ${runId}` });
    createdExerciseIds.push(y.id);
    await coachExercisesService.replaceAssignments(coachId, y.id, { groupIds: [], athleteIds: [athleteB] });

    // Les VRAIS GET /exercises et GET /exercises/:id athlète, aucune connaissance du monde coach.
    const listForA = await exercisesService.findAll(athleteA);
    const listForB = await exercisesService.findAll(athleteB);

    const titlesForA = listForA.map((e) => e.titre);
    const titlesForB = listForB.map((e) => e.titre);

    expect(titlesForA).toContain(`G global ${runId}`);
    expect(titlesForA).toContain(`X publié A ${runId}`);
    expect(titlesForA).not.toContain(`Y publié B ${runId}`);

    expect(titlesForB).toContain(`G global ${runId}`);
    expect(titlesForB).toContain(`Y publié B ${runId}`);
    expect(titlesForB).not.toContain(`X publié A ${runId}`);

    // Détail : A peut voir X, jamais Y.
    await expect(exercisesService.findOne(x.id, athleteA)).resolves.toMatchObject({ titre: `X publié A ${runId}` });
    await expect(exercisesService.findOne(y.id, athleteA)).rejects.toThrow();
  });

  it("athlète sans aucune publication ne voit que les exercices globaux", async () => {
    const coachId = await makeCoach();
    const athleteC = await makeAthlete("C");
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteC } });

    const x = await coachExercisesService.createExercise(coachId, { title: `X non publié à C ${runId}` });
    createdExerciseIds.push(x.id);
    // Jamais publié à athleteC.

    const list = await exercisesService.findAll(athleteC);
    expect(list.map((e) => e.titre)).not.toContain(`X non publié à C ${runId}`);
  });

  it("une modification de contenu côté coach est immédiatement visible via le vrai GET /exercises/:id athlète (une seule ligne partagée)", async () => {
    const coachId = await makeCoach();
    const athleteA = await makeAthlete("A");
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteA } });

    const x = await coachExercisesService.createExercise(coachId, { title: `Avant ${runId}` });
    createdExerciseIds.push(x.id);
    await coachExercisesService.replaceAssignments(coachId, x.id, { groupIds: [], athleteIds: [athleteA] });

    await coachExercisesService.updateContent(x.id, { title: `Après ${runId}` });

    const detail = await exercisesService.findOne(x.id, athleteA);
    expect(detail.titre).toBe(`Après ${runId}`);
  });

  it("un exercice supprimé par le coach disparaît immédiatement du GET /exercises athlète", async () => {
    const coachId = await makeCoach();
    const athleteA = await makeAthlete("A");
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteA } });

    const x = await coachExercisesService.createExercise(coachId, { title: `À supprimer ${runId}` });
    await coachExercisesService.replaceAssignments(coachId, x.id, { groupIds: [], athleteIds: [athleteA] });
    expect((await exercisesService.findAll(athleteA)).map((e) => e.titre)).toContain(`À supprimer ${runId}`);

    await coachExercisesService.deleteExercise(x.id);

    expect((await exercisesService.findAll(athleteA)).map((e) => e.titre)).not.toContain(`À supprimer ${runId}`);
  });
});
