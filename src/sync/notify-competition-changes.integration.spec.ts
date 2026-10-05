import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsRepository } from "../notifications/notifications.repository";
import { notifyCompetitionChanges } from "./sources-sync";

// Intégration Postgres réelle : qui est prévenu d'un changement de compétition.
describe("notifyCompetitionChanges (intégration Postgres)", () => {
  let prisma: PrismaService;
  const runId = Date.now();
  const userIds: string[] = [];
  let competitionId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    competitionId = (await prisma.competition.create({ data: { nom: `Open sync ${runId}`, date_debut: new Date("2027-03-20") } })).id;
  });

  afterAll(async () => {
    await prisma.app_user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.competition.deleteMany({ where: { id: competitionId } });
    await prisma.$disconnect();
  });

  async function user(tag: string) {
    const u = await prisma.app_user.create({ data: { email: `test-fixture-sync-${tag}-${runId}@test.fr` } });
    userIds.push(u.id);
    return u.id;
  }

  it("athlète inscrit et coach qui prépare : prévenus ; athlète retiré et autre coach : jamais", async () => {
    const inscrit = await prisma.athlete.create({ data: { user_id: await user("inscrit") } });
    const retire = await prisma.athlete.create({ data: { user_id: await user("retire") } });
    await prisma.participation.create({ data: { athlete_id: inscrit.id, competition_id: competitionId } });
    await prisma.participation.create({ data: { athlete_id: retire.id, competition_id: competitionId, statut: "retire" } });
    const coachUser = await user("coach");
    const coach = await prisma.coach_profile.create({ data: { user_id: coachUser } });
    await prisma.coach_competition_preparation.create({ data: { coach_id: coach.id, athlete_id: inscrit.id, competition_id: competitionId } });
    const otherCoachUser = await user("autre-coach");
    await prisma.coach_profile.create({ data: { user_id: otherCoachUser } });

    const sent = await notifyCompetitionChanges(prisma, new NotificationsRepository(prisma), [
      { competitionId, nom: `Open sync ${runId}`, changes: [{ field: "date_debut", before: "2027-03-13", after: "2027-03-20" }] },
    ]);

    expect(sent).toBe(2);
    const rows = await prisma.notification.findMany({ where: { recipient_user_id: { in: userIds } } });
    expect(rows.map((r) => [r.recipient_user_id, r.context]).sort()).toEqual(
      [[inscrit.user_id, "ATHLETE"], [coachUser, "COACH"]].sort(),
    );
    expect(rows[0]).toEqual(
      expect.objectContaining({ type: "COMPETITION_UPDATED", resource_type: "COMPETITION", resource_id: competitionId }),
    );
    expect(rows[0].message).toContain("date 13 mars 2027 → 20 mars 2027");
  });
});
