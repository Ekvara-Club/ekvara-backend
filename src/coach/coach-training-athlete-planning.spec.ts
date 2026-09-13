import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { TrainingsService } from "../trainings/trainings.service";
import { TrainingsRepository } from "../trainings/trainings.repository";
import { CoachTrainingsService } from "./coach-trainings.service";
import { CoachTrainingsRepository } from "./coach-trainings.repository";
import { CoachDestinataireResolver } from "./coach-destinataire-resolver";
import { NotificationsRepository } from "../notifications/notifications.repository";

// LE test le plus important de ce ticket (voir ticket §28) : une séance créée
// via le service COACH doit apparaître dans le planning d'un athlète en
// passant EXCLUSIVEMENT par TrainingsService/TrainingsRepository — le VRAI
// code athlete-facing, strictement inchangé par ce ticket, jamais un chemin
// spécial "coach-aware". Si ce fichier passe, le contrat du ticket §17/§25
// ("le frontend athlète ne doit subir aucune modification") est prouvé, pas
// supposé.
describe("Non-régression : planning athlète après création coach (intégration Postgres)", () => {
  let prisma: PrismaService;
  let coachTrainingsService: CoachTrainingsService;
  let trainingsService: TrainingsService; // service ATHLETE-FACING réel, non modifié
  const runId = Date.now();
  const createdUserIds: string[] = [];
  let counter = 0;

  beforeAll(() => {
    prisma = new PrismaService();
    coachTrainingsService = new CoachTrainingsService(
      new CoachTrainingsRepository(prisma, new NotificationsRepository(prisma)),
      new CoachDestinataireResolver(prisma),
    );
    trainingsService = new TrainingsService(new TrainingsRepository(prisma));
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
      data: { email: `test-fixture-planning-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `F${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return { coachId: profile.id, userId: user.id };
  }

  async function makeAthlete(prenom: string): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-planning-athlete-${runId}-${counter}@test.fr`, nom: "Test", prenom },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
    return athlete.id;
  }

  it("coach crée une séance pour A/B/C -> présente dans le planning RÉEL de A, B, C — absente pour D non assigné", async () => {
    const { coachId, userId: actorUserId } = await makeCoach();
    const athleteA = await makeAthlete("A");
    const athleteB = await makeAthlete("B");
    const athleteC = await makeAthlete("C");
    const athleteD = await makeAthlete("D"); // jamais assigné

    for (const id of [athleteA, athleteB, athleteC]) {
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: id } });
    }

    await coachTrainingsService.createTraining(coachId, actorUserId, {
      title: `Combat collectif ${runId}`,
      startAt: "2026-09-05T20:00:00.000Z",
      athleteIds: [athleteA, athleteB, athleteC],
    });

    // Les VRAIS endpoints athlète, sans aucune connaissance du monde coach.
    for (const athleteId of [athleteA, athleteB, athleteC]) {
      const list = await trainingsService.findAllForAthlete(athleteId);
      expect(list.some((t) => t.title === `Combat collectif ${runId}`)).toBe(true);

      const next = await trainingsService.findNextForAthlete(athleteId);
      expect(next?.title).toBe(`Combat collectif ${runId}`);
    }

    const listD = await trainingsService.findAllForAthlete(athleteD);
    expect(listD.some((t) => t.title === `Combat collectif ${runId}`)).toBe(false);
    expect(await trainingsService.findNextForAthlete(athleteD)).toBeNull();
  });

  it("une modification d'horaire côté coach est immédiatement visible via findNextForAthlete (VRAI endpoint athlète)", async () => {
    const { coachId, userId: actorUserId } = await makeCoach();
    const athleteA = await makeAthlete("A");
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteA } });

    const created = await coachTrainingsService.createTraining(coachId, actorUserId, {
      title: `Séance horaire ${runId}`,
      startAt: "2026-09-05T20:00:00.000Z",
      athleteIds: [athleteA],
    });

    await coachTrainingsService.updateContent(created.id, actorUserId, { startAt: "2026-09-05T20:30:00.000Z" });

    const next = await trainingsService.findNextForAthlete(athleteA);
    expect(next?.startAt.toISOString()).toBe("2026-09-05T20:30:00.000Z");
  });

  it("une séance annulée côté coach disparaît de findNextForAthlete (réutilise INACTIVE_TRAINING_STATUSES existant, aucun filtre spécial)", async () => {
    const { coachId, userId: actorUserId } = await makeCoach();
    const athleteA = await makeAthlete("A");
    await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteA } });

    const created = await coachTrainingsService.createTraining(coachId, actorUserId, {
      title: `Séance annulable ${runId}`,
      startAt: "2026-09-05T20:00:00.000Z",
      athleteIds: [athleteA],
    });

    expect((await trainingsService.findNextForAthlete(athleteA))?.title).toBe(`Séance annulable ${runId}`);

    await coachTrainingsService.cancel(created.id, actorUserId);

    expect(await trainingsService.findNextForAthlete(athleteA)).toBeNull();
    // Toujours dans l'historique complet (soft cancel, pas de suppression) :
    const all = await trainingsService.findAllForAthlete(athleteA);
    expect(all.some((t) => t.title === `Séance annulable ${runId}`)).toBe(true);
  });

  it("un athlète continue de pouvoir créer SA PROPRE séance via POST /athletes/:id/trainings, indépendamment du monde coach", async () => {
    const athleteA = await makeAthlete("A");

    const own = await trainingsService.createTraining(athleteA, {
      title: `Séance perso ${runId}`,
      startAt: "2026-09-06T08:00:00.000Z",
    });

    expect(own.title).toBe(`Séance perso ${runId}`);
    const next = await trainingsService.findNextForAthlete(athleteA);
    expect(next?.title).toBe(`Séance perso ${runId}`);
  });
});
