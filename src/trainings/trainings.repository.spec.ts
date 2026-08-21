import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { TrainingsRepository } from "./trainings.repository";

// Test d'intégration contre la vraie base Postgres locale : la règle temporelle
// du "prochain entraînement" (date_fin si elle existe, sinon date_debut, statut
// actif) est portée par la requête Prisma elle-même (OR + notIn), qu'un mock ne
// peut pas valider sincèrement. Athlète jetable créé ici et nettoyé en afterAll
// — l'athlète de développement n'est jamais touché.
describe("TrainingsRepository (intégration Postgres)", () => {
  let prisma: PrismaService;
  let repository: TrainingsRepository;

  let athleteId: string;
  let userId: string;
  const trainingIds: string[] = [];

  const runId = Date.now();

  function hoursFromNow(offset: number, from = new Date()): Date {
    return new Date(from.getTime() + offset * 60 * 60 * 1000);
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    repository = new TrainingsRepository(prisma);

    const user = await prisma.app_user.create({
      data: { email: `test-fixture-trainings-${runId}@test.fr`, nom: "Fixture", prenom: "Trainings" },
    });
    userId = user.id;
    const athlete = await prisma.athlete.create({ data: { user_id: userId } });
    athleteId = athlete.id;
  }, 30000);

  afterEach(async () => {
    if (trainingIds.length > 0) {
      await prisma.training_session.deleteMany({ where: { id: { in: trainingIds } } });
      trainingIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.athlete.delete({ where: { id: athleteId } });
    await prisma.app_user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  }, 30000);

  it("createTraining persiste la séance avec les vrais champs Prisma", async () => {
    const created = await repository.createTraining(athleteId, {
      title: "Taekwondo au club",
      type: "taekwondo",
      subType: "combat",
      startAt: hoursFromNow(24),
      endAt: hoursFromNow(26),
      location: "Arena Teddy Riner",
      level: "Elite",
    });
    trainingIds.push(created.id);

    expect(created.titre).toBe("Taekwondo au club");
    expect(created.statut).toBe("prevu");
  });

  it("findAllByAthlete trie par date_debut desc", async () => {
    const now = new Date();
    const rows = await Promise.all([
      repository.createTraining(athleteId, { title: "Ancienne", startAt: hoursFromNow(-48, now) }),
      repository.createTraining(athleteId, { title: "Récente", startAt: hoursFromNow(24, now) }),
      repository.createTraining(athleteId, { title: "Intermédiaire", startAt: hoursFromNow(-2, now) }),
    ]);
    trainingIds.push(...rows.map((r) => r.id));

    const all = await repository.findAllByAthlete(athleteId);
    const testRows = all.filter((t) => rows.some((r) => r.id === t.id));

    expect(testRows.map((t) => t.titre)).toEqual(["Récente", "Intermédiaire", "Ancienne"]);
  });

  describe("findAllByAthlete avec range (from/to)", () => {
    it("ne retourne que les séances dont date_debut est dans la période (bornes incluses)", async () => {
      const from = new Date("2026-08-17T00:00:00.000Z");
      const to = new Date("2026-08-23T23:59:59.999Z");

      const before = await repository.createTraining(athleteId, {
        title: "Avant la période",
        startAt: new Date("2026-08-16T23:59:59.999Z"),
      });
      const onFromBound = await repository.createTraining(athleteId, {
        title: "Exactement sur from",
        startAt: from,
      });
      const inside = await repository.createTraining(athleteId, {
        title: "Dans la période",
        startAt: new Date("2026-08-20T18:30:00.000Z"),
      });
      const onToBound = await repository.createTraining(athleteId, {
        title: "Exactement sur to",
        startAt: to,
      });
      const after = await repository.createTraining(athleteId, {
        title: "Après la période",
        startAt: new Date("2026-08-24T00:00:00.000Z"),
      });
      trainingIds.push(before.id, onFromBound.id, inside.id, onToBound.id, after.id);

      const result = await repository.findAllByAthlete(athleteId, { from, to });
      const testRows = result.filter((t) =>
        [onFromBound.id, inside.id, onToBound.id, before.id, after.id].includes(t.id),
      );

      expect(testRows.map((t) => t.id).sort()).toEqual(
        [onFromBound.id, inside.id, onToBound.id].sort(),
      );
    });

    it("aucune séance dans la période -> []", async () => {
      const result = await repository.findAllByAthlete(athleteId, {
        from: new Date("2020-01-01T00:00:00.000Z"),
        to: new Date("2020-01-07T23:59:59.999Z"),
      });

      expect(result).toEqual([]);
    });

    it("sans range -> comportement inchangé (tout l'historique)", async () => {
      const created = await repository.createTraining(athleteId, {
        title: "Peu importe la date",
        startAt: new Date("2020-05-05T00:00:00.000Z"),
      });
      trainingIds.push(created.id);

      const result = await repository.findAllByAthlete(athleteId);

      expect(result.some((t) => t.id === created.id)).toBe(true);
    });
  });

  describe("findNextByAthlete", () => {
    it("une séance passée est exclue", async () => {
      const now = new Date();
      const past = await repository.createTraining(athleteId, {
        title: "Passée",
        startAt: hoursFromNow(-5, now),
        endAt: hoursFromNow(-3, now),
      });
      trainingIds.push(past.id);

      const next = await repository.findNextByAthlete(athleteId, now);

      expect(next).toBeNull();
    });

    it("sélectionne la séance future la plus proche (1 jour avant 3 jours)", async () => {
      const now = new Date();
      const in3days = await repository.createTraining(athleteId, {
        title: "Dans 3 jours",
        startAt: hoursFromNow(72, now),
      });
      const in1day = await repository.createTraining(athleteId, {
        title: "Dans 1 jour",
        startAt: hoursFromNow(24, now),
      });
      trainingIds.push(in3days.id, in1day.id);

      const next = await repository.findNextByAthlete(athleteId, now);

      expect(next?.id).toBe(in1day.id);
    });

    it("une séance annulée est exclue", async () => {
      const now = new Date();
      const cancelled = await prisma.training_session.create({
        data: {
          athlete_id: athleteId,
          titre: "Annulée",
          date_debut: hoursFromNow(24, now),
          statut: "annule",
        },
      });
      trainingIds.push(cancelled.id);

      const next = await repository.findNextByAthlete(athleteId, now);

      expect(next).toBeNull();
    });

    it("une séance en cours avec date_fin future reste sélectionnable", async () => {
      const now = new Date();
      const inProgress = await repository.createTraining(athleteId, {
        title: "En cours",
        startAt: hoursFromNow(-1, now),
        endAt: hoursFromNow(1, now),
      });
      trainingIds.push(inProgress.id);

      const next = await repository.findNextByAthlete(athleteId, now);

      expect(next?.id).toBe(inProgress.id);
    });

    it("une séance déjà commencée sans date_fin est exclue", async () => {
      const now = new Date();
      const startedNoEnd = await repository.createTraining(athleteId, {
        title: "Commencée sans fin",
        startAt: hoursFromNow(-1, now),
      });
      trainingIds.push(startedNoEnd.id);

      const next = await repository.findNextByAthlete(athleteId, now);

      expect(next).toBeNull();
    });

    it("aucune séance éligible -> null", async () => {
      const next = await repository.findNextByAthlete(athleteId, new Date());
      expect(next).toBeNull();
    });
  });

  it("athleteExists", async () => {
    await expect(repository.athleteExists(athleteId)).resolves.toBe(true);
    await expect(repository.athleteExists("00000000-0000-0000-0000-000000000000")).resolves.toBe(false);
  });
});
