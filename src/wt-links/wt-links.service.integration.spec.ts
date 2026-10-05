import "dotenv/config";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsRepository } from "../notifications/notifications.repository";
import { WtLinksService } from "./wt-links.service";

// Intégration Postgres réelle. Fixtures jetables : noms uniques par run (ne
// croisent jamais les vrais profils WT importés), nettoyées en afterEach
// (cascade app_user -> athlete/coach_profile/athlete_wt_link ; profils WT
// supprimés explicitement).
describe("WtLinksService (intégration Postgres)", () => {
  let prisma: PrismaService;
  let service: WtLinksService;
  const runId = Date.now();
  const first = `Zorg${runId}`;
  const last = "Fixturewt";
  const userIds: string[] = [];
  const externalIds: string[] = [];
  let counter = 0;

  beforeAll(() => {
    prisma = new PrismaService();
    service = new WtLinksService(prisma, new NotificationsRepository(prisma));
  });

  afterEach(async () => {
    await prisma.app_user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.external_athlete.deleteMany({ where: { id: { in: externalIds } } });
    userIds.length = 0;
    externalIds.length = 0;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeAthlete(prenom = first, nom = last) {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-wtlink-${runId}-${counter}@test.fr`, prenom, nom },
    });
    userIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
    return { athleteId: athlete.id, userId: user.id };
  }

  async function makeCoachFor(athleteId: string) {
    counter += 1;
    const user = await prisma.app_user.create({ data: { email: `test-fixture-wtlink-coach-${runId}-${counter}@test.fr`, prenom: "Coach" } });
    userIds.push(user.id);
    const coach = await prisma.coach_profile.create({ data: { user_id: user.id } });
    await prisma.coach_athlete.create({ data: { coach_id: coach.id, athlete_id: athleteId } });
    return user.id;
  }

  async function makeExternal(displayName: string, countryCode = "FRA") {
    const row = await prisma.external_athlete.create({ data: { display_name: displayName, country_code: countryCode } });
    externalIds.push(row.id);
    return row.id;
  }

  const notifs = (userId: string) => prisma.notification.findMany({ where: { recipient_user_id: userId }, orderBy: { created_at: "asc" } });

  it("suggestions : même prénom + nom (accents/casse/ordre ignorés), France en premier, jamais un homonyme partiel", async () => {
    const { athleteId } = await makeAthlete(`Zorg${runId}`, "Fïxturewt");
    const fra = await makeExternal(`FIXTUREWT Zorg${runId}`, "FRA");
    const bel = await makeExternal(`Zorg${runId} FIXTUREWT`, "BEL");
    await makeExternal(`Autre${runId} FIXTUREWT`, "FRA");

    const view = await service.getForAthlete(athleteId);

    expect(view.link).toBeNull();
    expect(view.suggestions.map((s) => s.id)).toEqual([fra, bel]);
  });

  it("demande : lien en attente, coachs notifiés (contexte COACH, deep-link fiche) ; redemander = rien de nouveau", async () => {
    const { athleteId, userId } = await makeAthlete();
    const coachUserId = await makeCoachFor(athleteId);
    const ext = await makeExternal(`ZORG${runId} FIXTUREWT`);

    const view = await service.request(athleteId, userId, ext);
    await service.request(athleteId, userId, ext);

    expect(view.link).toEqual(
      expect.objectContaining({ status: "pending", externalAthlete: { id: ext, displayName: `ZORG${runId} FIXTUREWT`, countryCode: "FRA" } }),
    );
    const coachNotifs = await notifs(coachUserId);
    expect(coachNotifs).toHaveLength(1);
    expect(coachNotifs[0]).toEqual(
      expect.objectContaining({ context: "COACH", type: "WT_PROFILE_LINK_REQUESTED", resource_type: "ATHLETE", resource_id: athleteId }),
    );
  });

  it("confirmation par le coach : lien confirmé, athlète notifié ; profil alors indisponible pour un autre compte (suggestion et demande)", async () => {
    const owner = await makeAthlete();
    const coachUserId = await makeCoachFor(owner.athleteId);
    const ext = await makeExternal(`ZORG${runId} FIXTUREWT`);
    await service.request(owner.athleteId, owner.userId, ext);

    await service.decide(owner.athleteId, coachUserId, "confirm");

    const link = await prisma.athlete_wt_link.findUniqueOrThrow({ where: { athlete_id: owner.athleteId } });
    expect(link).toEqual(expect.objectContaining({ status: "confirmed", decided_by_user_id: coachUserId }));
    expect((await notifs(owner.userId)).at(-1)).toEqual(
      expect.objectContaining({ context: "ATHLETE", type: "WT_PROFILE_LINK_CONFIRMED", resource_type: "WT_PROFILE" }),
    );

    const homonym = await makeAthlete();
    expect((await service.getForAthlete(homonym.athleteId)).suggestions).toEqual([]);
    await expect(service.request(homonym.athleteId, homonym.userId, ext)).rejects.toBeInstanceOf(ConflictException);
  });

  it("refus par le coach : demande supprimée, athlète notifié, il peut redemander ; plus rien à trancher ensuite (404)", async () => {
    const { athleteId, userId } = await makeAthlete();
    const coachUserId = await makeCoachFor(athleteId);
    const ext = await makeExternal(`ZORG${runId} FIXTUREWT`);
    await service.request(athleteId, userId, ext);

    await service.decide(athleteId, coachUserId, "reject");

    expect(await prisma.athlete_wt_link.findUnique({ where: { athlete_id: athleteId } })).toBeNull();
    expect((await notifs(userId)).at(-1)?.type).toBe("WT_PROFILE_LINK_REJECTED");
    await expect(service.decide(athleteId, coachUserId, "confirm")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("retrait par l'athlète : lien supprimé, suggestions de nouveau proposées ; profil inconnu -> 404", async () => {
    const { athleteId, userId } = await makeAthlete();
    const ext = await makeExternal(`ZORG${runId} FIXTUREWT`);
    await service.request(athleteId, userId, ext);

    const view = await service.unlink(athleteId);

    expect(view.link).toBeNull();
    expect(view.suggestions.map((s) => s.id)).toEqual([ext]);
    await expect(service.request(athleteId, userId, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(NotFoundException);
  });
});
