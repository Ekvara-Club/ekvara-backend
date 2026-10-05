import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { MetricsRepository } from "./metrics.repository";
import { MetricsService } from "./metrics.service";

// Intégration Postgres réelle : le barème enregistré par un coach s'applique
// aux athlètes de SON club (et seulement à eux), et se réinitialise.
describe("Barème de club — étoile de compétences (intégration Postgres)", () => {
  let prisma: PrismaService;
  let service: MetricsService;
  const runId = Date.now();
  const userIds: string[] = [];
  const clubIds: string[] = [];
  let reactionTypeId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    service = new MetricsService(new MetricsRepository(prisma));
    reactionTypeId = (await prisma.metric_type.findUniqueOrThrow({ where: { code: "temps_reaction" } })).id;
  });

  afterAll(async () => {
    await prisma.app_user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.club.deleteMany({ where: { id: { in: clubIds } } });
    await prisma.$disconnect();
  });

  async function user(tag: string) {
    const u = await prisma.app_user.create({ data: { email: `test-fixture-scale-${tag}-${runId}@test.fr` } });
    userIds.push(u.id);
    return u.id;
  }

  async function athleteIn(clubId: string | null, tag: string) {
    const athlete = await prisma.athlete.create({ data: { user_id: await user(tag), club_id: clubId } });
    await prisma.metric_measurement.createMany({
      data: [
        { athlete_id: athlete.id, metric_type_id: reactionTypeId, valeur: 420, mesure_le: new Date("2026-09-01T10:00:00Z") },
        { athlete_id: athlete.id, metric_type_id: reactionTypeId, valeur: 380, mesure_le: new Date("2026-09-08T10:00:00Z") },
      ],
    });
    return athlete.id;
  }

  const reactionScore = async (athleteId: string) =>
    (await service.getOverview(athleteId)).metrics.find((m) => m.id === reactionTypeId)?.score;

  it("barème du club appliqué à ses athlètes uniquement, puis retour au défaut", async () => {
    const club = await prisma.club.create({ data: { nom: `Club barème ${runId}` } });
    const otherClub = await prisma.club.create({ data: { nom: `Autre club ${runId}` } });
    clubIds.push(club.id, otherClub.id);
    const coachUserId = await user("coach");
    const coach = await prisma.coach_profile.create({ data: { user_id: coachUserId, club_id: club.id } });
    const member = await athleteIn(club.id, "member");
    const outsider = await athleteIn(otherClub.id, "outsider");

    expect(await reactionScore(member)).toBe(63); // défaut 600 -> 250

    await service.saveClubScales(coach.id, coachUserId, [{ metricTypeId: reactionTypeId, scoreZero: 500, scoreHundred: 300 }]);
    expect(await reactionScore(member)).toBe(60);
    expect(await reactionScore(outsider)).toBe(63);

    const { scales } = await service.getClubScales(coach.id);
    expect(scales.find((s) => s.metricTypeId === reactionTypeId)?.effective).toEqual({ scoreZero: 500, scoreHundred: 300 });

    await service.saveClubScales(coach.id, coachUserId, [{ metricTypeId: reactionTypeId, scoreZero: null, scoreHundred: null }]);
    expect(await reactionScore(member)).toBe(63);
    expect(await prisma.club_metric_scale.count({ where: { club_id: club.id } })).toBe(0);
  });
});
