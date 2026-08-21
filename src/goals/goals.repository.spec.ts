import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { GoalsRepository } from "./goals.repository";

// Test d'intégration contre la vraie base Postgres locale : la sélection de
// l'objectif actif (statut + date_cible la plus proche, nulls en dernier) et les
// vérifications d'appartenance sont des règles portées par la requête Prisma
// elle-même, qu'un mock ne peut pas valider sincèrement. Athlètes jetables créés
// ici et nettoyés en afterAll — l'athlète de développement n'est jamais touché.
describe("GoalsRepository (intégration Postgres)", () => {
  let prisma: PrismaService;
  let repository: GoalsRepository;

  let athleteId: string;
  let otherAthleteId: string;
  let userId: string;
  let otherUserId: string;
  const goalIds: string[] = [];

  const runId = Date.now();

  beforeAll(async () => {
    prisma = new PrismaService();
    repository = new GoalsRepository(prisma);

    const user = await prisma.app_user.create({
      data: { email: `test-fixture-goals-${runId}@test.fr`, nom: "Fixture", prenom: "Goals" },
    });
    userId = user.id;
    const athlete = await prisma.athlete.create({ data: { user_id: userId } });
    athleteId = athlete.id;

    const otherUser = await prisma.app_user.create({
      data: { email: `test-fixture-goals-other-${runId}@test.fr`, nom: "Fixture", prenom: "Other" },
    });
    otherUserId = otherUser.id;
    const otherAthlete = await prisma.athlete.create({ data: { user_id: otherUserId } });
    otherAthleteId = otherAthlete.id;
  }, 30000);

  afterEach(async () => {
    if (goalIds.length > 0) {
      await prisma.athlete_goal.deleteMany({ where: { id: { in: goalIds } } });
      goalIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.athlete.delete({ where: { id: athleteId } });
    await prisma.app_user.delete({ where: { id: userId } });
    await prisma.athlete.delete({ where: { id: otherAthleteId } });
    await prisma.app_user.delete({ where: { id: otherUserId } });
    await prisma.$disconnect();
  }, 30000);

  it("createGoal persiste l'objectif", async () => {
    const created = await repository.createGoal(athleteId, { titre: "Podium au championnat de France" });
    goalIds.push(created.id);

    expect(created.titre).toBe("Podium au championnat de France");
    expect(created.statut).toBe("en_cours");
  });

  it("findActiveByAthlete sélectionne l'objectif en_cours dont la date_cible est la plus proche", async () => {
    const loin = await repository.createGoal(athleteId, {
      titre: "Loin",
      dateCible: new Date("2028-01-01"),
    });
    const proche = await repository.createGoal(athleteId, {
      titre: "Proche",
      dateCible: new Date("2027-01-01"),
    });
    goalIds.push(loin.id, proche.id);

    const active = await repository.findActiveByAthlete(athleteId);

    expect(active?.id).toBe(proche.id);
  });

  it("findActiveByAthlete fait passer les objectifs sans date_cible après ceux qui en ont une", async () => {
    const sansDate = await repository.createGoal(athleteId, { titre: "Sans date" });
    const avecDate = await repository.createGoal(athleteId, {
      titre: "Avec date",
      dateCible: new Date("2030-01-01"),
    });
    goalIds.push(sansDate.id, avecDate.id);

    const active = await repository.findActiveByAthlete(athleteId);

    expect(active?.id).toBe(avecDate.id);
  });

  it("findActiveByAthlete ignore les objectifs non en_cours", async () => {
    await prisma.athlete_goal.create({
      data: { athlete_id: athleteId, titre: "Abandonné", statut: "abandonne" },
    });

    const active = await repository.findActiveByAthlete(athleteId);

    expect(active).toBeNull();
  });

  it("goalBelongsToAthlete distingue l'athlète propriétaire d'un autre athlète", async () => {
    const created = await repository.createGoal(athleteId, { titre: "Objectif privé" });
    goalIds.push(created.id);

    await expect(repository.goalBelongsToAthlete(created.id, athleteId)).resolves.toBe(true);
    await expect(repository.goalBelongsToAthlete(created.id, otherAthleteId)).resolves.toBe(false);
  });

  it("createStep puis stepBelongsToGoal / updateStepCompleted", async () => {
    const created = await repository.createGoal(athleteId, { titre: "Avec étape" });
    goalIds.push(created.id);

    const step = await repository.createStep(created.id, { titre: "Top 8 des régionaux", ordre: 0 });

    await expect(repository.stepBelongsToGoal(step.id, created.id)).resolves.toBe(true);

    const otherGoal = await repository.createGoal(athleteId, { titre: "Autre objectif" });
    goalIds.push(otherGoal.id);
    await expect(repository.stepBelongsToGoal(step.id, otherGoal.id)).resolves.toBe(false);

    const completedAt = new Date();
    const updated = await repository.updateStepCompleted(step.id, true, completedAt);
    expect(updated.completed).toBe(true);
    expect(updated.completed_at).toEqual(completedAt);

    const uncompleted = await repository.updateStepCompleted(step.id, false, null);
    expect(uncompleted.completed).toBe(false);
    expect(uncompleted.completed_at).toBeNull();
  });

  it("findAllByAthlete renvoie les étapes triées par ordre", async () => {
    const created = await repository.createGoal(athleteId, { titre: "Avec étapes triées" });
    goalIds.push(created.id);

    await repository.createStep(created.id, { titre: "Deuxième", ordre: 1 });
    await repository.createStep(created.id, { titre: "Première", ordre: 0 });

    const all = await repository.findAllByAthlete(athleteId);
    const goal = all.find((g) => g.id === created.id);

    expect(goal?.goal_step.map((s) => s.titre)).toEqual(["Première", "Deuxième"]);
  });

  it("updateStatus change uniquement le statut, jamais les autres champs ni les steps", async () => {
    const created = await repository.createGoal(athleteId, {
      titre: "Objectif à faire évoluer",
      description: "Description initiale",
      dateCible: new Date("2027-06-01"),
    });
    goalIds.push(created.id);
    await repository.createStep(created.id, { titre: "Étape 1", ordre: 0 });

    const updated = await repository.updateStatus(created.id, "atteint");

    expect(updated.statut).toBe("atteint");
    expect(updated.titre).toBe("Objectif à faire évoluer");
    expect(updated.description).toBe("Description initiale");
    expect(updated.date_cible).toEqual(new Date("2027-06-01"));
    expect(updated.goal_step).toHaveLength(1);
    expect(updated.goal_step[0].titre).toBe("Étape 1");
  });
});
