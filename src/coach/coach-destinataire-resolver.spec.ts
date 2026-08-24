import "dotenv/config";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CoachDestinataireResolver } from "./coach-destinataire-resolver";

// Test d'intégration contre la vraie base Postgres locale : composant
// partagé entre les séances collectives et la publication d'exercices (voir
// commentaire dans coach-destinataire-resolver.ts). Fixtures jetables
// nettoyées en afterEach via cascade sur app_user.
describe("CoachDestinataireResolver (intégration Postgres)", () => {
  let prisma: PrismaService;
  let resolver: CoachDestinataireResolver;
  const runId = Date.now();
  const createdUserIds: string[] = [];
  let counter = 0;

  beforeAll(() => {
    prisma = new PrismaService();
    resolver = new CoachDestinataireResolver(prisma);
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

  async function makeCoach(): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-cdr-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `F${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return profile.id;
  }

  async function makeAthlete(): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-cdr-athlete-${runId}-${counter}@test.fr`, nom: `N${counter}`, prenom: `P${counter}` },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
    return athlete.id;
  }

  it("groupe n'appartenant pas au coach -> ForbiddenException", async () => {
    const coachA = await makeCoach();
    const coachB = await makeCoach();
    const groupB = await prisma.coach_group.create({ data: { coach_id: coachB, name: `GB ${runId}` } });

    await expect(resolver.resolve(coachA, [groupB.id], [])).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("athlète non lié au coach -> ForbiddenException", async () => {
    const coachA = await makeCoach();
    const athleteX = await makeAthlete();

    await expect(resolver.resolve(coachA, [], [athleteX])).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("aucun destinataire résolu -> BadRequestException", async () => {
    const coachA = await makeCoach();
    await expect(resolver.resolve(coachA, [], [])).rejects.toBeInstanceOf(BadRequestException);
  });

  it("groupe vide + aucun athlète explicite -> BadRequestException (union vide)", async () => {
    const coachA = await makeCoach();
    const group = await prisma.coach_group.create({ data: { coach_id: coachA, name: `G ${runId}` } });

    await expect(resolver.resolve(coachA, [group.id], [])).rejects.toBeInstanceOf(BadRequestException);
  });

  it("union groupe + athlète individuel, dédoublonnée", async () => {
    const coachA = await makeCoach();
    const athleteA = await makeAthlete();
    const athleteB = await makeAthlete();
    await prisma.coach_athlete.create({ data: { coach_id: coachA, athlete_id: athleteA } });
    const group = await prisma.coach_group.create({ data: { coach_id: coachA, name: `G ${runId}` } });
    await prisma.coach_group_athlete.create({ data: { group_id: group.id, athlete_id: athleteA } });
    await prisma.coach_group_athlete.create({ data: { group_id: group.id, athlete_id: athleteB } });

    const result = await resolver.resolve(coachA, [group.id], [athleteA]);

    expect(result.athleteIds.sort()).toEqual([athleteA, athleteB].sort());
    expect(result.athleteIds).toHaveLength(2); // dédoublonné
    expect(result.groupIds).toEqual([group.id]);
  });
});
