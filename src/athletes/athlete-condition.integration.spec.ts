import "dotenv/config";
import { BadRequestException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsRepository } from "../notifications/notifications.repository";
import { AthletesService } from "./athletes.service";

// Intégration Postgres réelle : écriture de l'état, effacement au retour à
// "actif", notification COACH par coach lié, idempotence. Fixtures jetables
// (emails uniques par run), nettoyées par cascade sur app_user.
describe("AthletesService.updateCondition (intégration Postgres)", () => {
  let prisma: PrismaService;
  let service: AthletesService;
  const runId = Date.now();
  const createdUserIds: string[] = [];
  let counter = 0;
  const NOW = new Date("2026-10-05T10:00:00.000Z");

  beforeAll(() => {
    prisma = new PrismaService();
    service = new AthletesService(prisma, new NotificationsRepository(prisma));
  });

  afterEach(async () => {
    await prisma.app_user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeUser(prefix: string, prenom: string) {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-cond-${prefix}-${runId}-${counter}@test.fr`, prenom, nom: "Fixture" },
    });
    createdUserIds.push(user.id);
    return user;
  }

  async function setup() {
    const athleteUser = await makeUser("athlete", "Kaïs");
    const athlete = await prisma.athlete.create({ data: { user_id: athleteUser.id } });
    const coachA = await makeUser("coach", "CoachA");
    const coachB = await makeUser("coach", "CoachB");
    const otherCoach = await makeUser("coach", "Autre");
    for (const coach of [coachA, coachB]) {
      const profile = await prisma.coach_profile.create({ data: { user_id: coach.id } });
      await prisma.coach_athlete.create({ data: { coach_id: profile.id, athlete_id: athlete.id } });
    }
    await prisma.coach_profile.create({ data: { user_id: otherCoach.id } });
    return { athlete, athleteUser, coachUserIds: [coachA.id, coachB.id], otherCoachUserId: otherCoach.id };
  }

  const notificationsFor = (userIds: string[]) =>
    prisma.notification.findMany({ where: { recipient_user_id: { in: userIds } }, orderBy: { created_at: "asc" } });

  it("nouveau statut : écrit en base, une notification COACH par coach lié (jamais les autres coachs)", async () => {
    const { athlete, athleteUser, coachUserIds, otherCoachUserId } = await setup();

    const view = await service.updateCondition(
      athlete.id,
      athleteUser.id,
      { status: "blesse", note: "  Entorse cheville  ", expectedReturn: "2026-10-20" },
      NOW,
    );

    expect(view).toEqual({ status: "blesse", note: "Entorse cheville", expectedReturn: "2026-10-20", updatedAt: NOW });
    const row = await prisma.athlete.findUniqueOrThrow({ where: { id: athlete.id } });
    expect(row.etat_forme).toBe("blesse");
    expect(row.etat_forme_retour?.toISOString().slice(0, 10)).toBe("2026-10-20");

    const notifications = await notificationsFor([...coachUserIds, otherCoachUserId]);
    expect(notifications.map((n) => n.recipient_user_id).sort()).toEqual([...coachUserIds].sort());
    expect(notifications[0]).toEqual(
      expect.objectContaining({
        context: "COACH",
        type: "ATHLETE_CONDITION_UPDATED",
        title: "Kaïs Fixture : Blessé",
        message: "Kaïs Fixture a indiqué : Blessé — Entorse cheville, retour prévu le 20 octobre 2026.",
        resource_type: "ATHLETE",
        resource_id: athlete.id,
        actor_user_id: athleteUser.id,
      }),
    );
  });

  it("même état renvoyé : rien n'est réécrit ni notifié (idempotent)", async () => {
    const { athlete, athleteUser, coachUserIds } = await setup();
    await service.updateCondition(athlete.id, athleteUser.id, { status: "malade", note: "Grippe" }, NOW);

    await service.updateCondition(athlete.id, athleteUser.id, { status: "malade", note: "Grippe" }, new Date("2026-10-06T10:00:00.000Z"));

    expect(await notificationsFor(coachUserIds)).toHaveLength(2);
    const row = await prisma.athlete.findUniqueOrThrow({ where: { id: athlete.id } });
    expect(row.etat_forme_updated_at).toEqual(NOW);
  });

  it("retour à Actif : commentaire et date effacés, coachs prévenus du retour", async () => {
    const { athlete, athleteUser, coachUserIds } = await setup();
    await service.updateCondition(athlete.id, athleteUser.id, { status: "blesse", note: "Genou", expectedReturn: "2026-11-01" }, NOW);

    const view = await service.updateCondition(
      athlete.id,
      athleteUser.id,
      { status: "actif", note: "ignoré", expectedReturn: "2026-12-01" },
      NOW,
    );

    expect(view).toEqual({ status: "actif", note: null, expectedReturn: null, updatedAt: NOW });
    const last = (await notificationsFor(coachUserIds)).at(-1)!;
    expect(last.title).toBe("Kaïs Fixture est de nouveau disponible");
  });

  it("date de retour déjà passée ou inexistante -> 400, rien écrit", async () => {
    const { athlete, athleteUser, coachUserIds } = await setup();

    await expect(
      service.updateCondition(athlete.id, athleteUser.id, { status: "blesse", expectedReturn: "2026-10-04" }, NOW),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.updateCondition(athlete.id, athleteUser.id, { status: "blesse", expectedReturn: "2026-02-30" }, NOW),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect((await prisma.athlete.findUniqueOrThrow({ where: { id: athlete.id } })).etat_forme).toBe("actif");
    expect(await notificationsFor(coachUserIds)).toHaveLength(0);
  });

  it("date de retour = aujourd'hui (heure de Paris) : acceptée", async () => {
    const { athlete, athleteUser } = await setup();
    const view = await service.updateCondition(athlete.id, athleteUser.id, { status: "absent", expectedReturn: "2026-10-05" }, NOW);
    expect(view.expectedReturn).toBe("2026-10-05");
  });
});
