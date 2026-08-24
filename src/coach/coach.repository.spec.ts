import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { CoachRepository } from "./coach.repository";

// Test d'intégration contre la vraie base Postgres locale : les contraintes
// uniques (coach_profile.user_id, coach_athlete(coach_id, athlete_id)) et la
// transaction de suppression (removeCoachAthlete) dépendent de comportements
// Postgres réels qu'un mock ne peut pas valider sincèrement (voir
// CompetitionEntriesRepository.spec.ts pour le même principe). Chaque test
// crée ses propres app_user/athlete/coach_profile jetables (nettoyés en
// afterEach via cascade sur app_user) — jamais les 7 utilisateurs réels de
// dev.
describe("CoachRepository (intégration Postgres)", () => {
  let prisma: PrismaService;
  let repository: CoachRepository;
  const runId = Date.now();
  const createdUserIds: string[] = [];

  beforeAll(() => {
    prisma = new PrismaService();
    repository = new CoachRepository(prisma);
  }, 30000);

  afterEach(async () => {
    if (createdUserIds.length > 0) {
      // onDelete: Cascade sur athlete.user_id et coach_profile.user_id, puis
      // sur coach_athlete/coach_group/coach_group_athlete en cascade depuis
      // coach_profile : un seul deleteMany suffit à tout nettoyer.
      await prisma.app_user.deleteMany({ where: { id: { in: createdUserIds } } });
      createdUserIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  }, 30000);

  let counter = 0;
  async function makeCoach(): Promise<{ userId: string; coachId: string }> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `Fixture${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return { userId: user.id, coachId: profile.id };
  }

  async function makeAthlete(): Promise<{ userId: string; athleteId: string }> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-athlete-${runId}-${counter}@test.fr`, nom: "Athlete", prenom: `Fixture${counter}` },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
    return { userId: user.id, athleteId: athlete.id };
  }

  describe("coach_profile", () => {
    it("contrainte unique user_id réellement appliquée par Postgres", async () => {
      const { userId } = await makeCoach();

      await expect(prisma.coach_profile.create({ data: { user_id: userId } })).rejects.toThrow();
    });

    it("findProfileByUserId / findProfileById renvoient app_user (sans password_hash) et club", async () => {
      const { userId, coachId } = await makeCoach();

      const byUserId = await repository.findProfileByUserId(userId);
      const byId = await repository.findProfileById(coachId);

      expect(byUserId?.id).toBe(coachId);
      expect(byId?.id).toBe(coachId);
      expect(byUserId?.app_user).not.toHaveProperty("password_hash");
      expect(byUserId?.club).toBeNull();
    });
  });

  describe("coach_athlete", () => {
    it("contrainte unique (coach_id, athlete_id) réellement appliquée par Postgres", async () => {
      const { coachId } = await makeCoach();
      const { athleteId } = await makeAthlete();

      await repository.createCoachAthlete(coachId, athleteId);

      await expect(repository.createCoachAthlete(coachId, athleteId)).rejects.toThrow();
    });

    it("coachAthleteExists reflète l'état réel en base", async () => {
      const { coachId } = await makeCoach();
      const { athleteId } = await makeAthlete();

      expect(await repository.coachAthleteExists(coachId, athleteId)).toBe(false);
      await repository.createCoachAthlete(coachId, athleteId);
      expect(await repository.coachAthleteExists(coachId, athleteId)).toBe(true);
    });

    it("findAthletesForCoach ne renvoie que les athlètes réellement liés à CE coach", async () => {
      const { coachId: coachAId } = await makeCoach();
      const { coachId: coachBId } = await makeCoach();
      const { athleteId: athleteForA } = await makeAthlete();
      const { athleteId: athleteForB } = await makeAthlete();

      await repository.createCoachAthlete(coachAId, athleteForA);
      await repository.createCoachAthlete(coachBId, athleteForB);

      const forA = await repository.findAthletesForCoach(coachAId);

      expect(forA).toHaveLength(1);
      expect(forA[0].athlete.id).toBe(athleteForA);
    });

    it("findUserByEmailWithAthlete : email inconnu -> null ; user sans athlete -> athlete null", async () => {
      const { userId: coachOnlyUserId } = await makeCoach();
      const coachOnlyUser = await prisma.app_user.findUnique({ where: { id: coachOnlyUserId } });

      expect(await repository.findUserByEmailWithAthlete("inconnu-vraiment@test.fr")).toBeNull();
      const result = await repository.findUserByEmailWithAthlete(coachOnlyUser!.email);
      expect(result?.athlete).toBeNull();
    });
  });

  describe("removeCoachAthlete (transactionnel)", () => {
    it("supprime le lien coach_athlete et les memberships de groupe DE CE COACH uniquement", async () => {
      const { coachId } = await makeCoach();
      const { athleteId } = await makeAthlete();
      await repository.createCoachAthlete(coachId, athleteId);
      const group = await prisma.coach_group.create({ data: { coach_id: coachId, name: `Groupe ${runId}` } });
      await prisma.coach_group_athlete.create({ data: { group_id: group.id, athlete_id: athleteId } });

      await repository.removeCoachAthlete(coachId, athleteId);

      expect(await repository.coachAthleteExists(coachId, athleteId)).toBe(false);
      const remainingMemberships = await prisma.coach_group_athlete.findMany({ where: { athlete_id: athleteId } });
      expect(remainingMemberships).toHaveLength(0);
    });

    it("isolation coach A/B : retirer l'athlète chez coach A ne touche jamais le lien ni les groupes de coach B (athlète partagé)", async () => {
      const { coachId: coachAId } = await makeCoach();
      const { coachId: coachBId } = await makeCoach();
      const { athleteId } = await makeAthlete();
      await repository.createCoachAthlete(coachAId, athleteId);
      await repository.createCoachAthlete(coachBId, athleteId);
      const groupB = await prisma.coach_group.create({ data: { coach_id: coachBId, name: `Groupe B ${runId}` } });
      await prisma.coach_group_athlete.create({ data: { group_id: groupB.id, athlete_id: athleteId } });

      await repository.removeCoachAthlete(coachAId, athleteId);

      expect(await repository.coachAthleteExists(coachAId, athleteId)).toBe(false);
      expect(await repository.coachAthleteExists(coachBId, athleteId)).toBe(true);
      const groupBMemberships = await prisma.coach_group_athlete.findMany({ where: { group_id: groupB.id } });
      expect(groupBMemberships).toHaveLength(1);
    });

    it("rollback transactionnel : un id de coach_athlete inexistant fait échouer toute l'opération sans effet partiel", async () => {
      const { coachId } = await makeCoach();
      const { athleteId } = await makeAthlete();
      const group = await prisma.coach_group.create({ data: { coach_id: coachId, name: `Groupe ${runId}` } });
      // Pas de coach_athlete créé : delete() sur un id inexistant doit lever (P2025).
      await expect(repository.removeCoachAthlete(coachId, athleteId)).rejects.toThrow();
      // Le groupe lui-même n'est pas affecté par cet échec.
      expect(await prisma.coach_group.findUnique({ where: { id: group.id } })).not.toBeNull();
    });
  });

  it("suppression de app_user supprime en cascade coach_profile puis coach_athlete/coach_group/coach_group_athlete", async () => {
    const { userId, coachId } = await makeCoach();
    const { athleteId } = await makeAthlete();
    await repository.createCoachAthlete(coachId, athleteId);
    const group = await prisma.coach_group.create({ data: { coach_id: coachId, name: `Groupe cascade ${runId}` } });
    await prisma.coach_group_athlete.create({ data: { group_id: group.id, athlete_id: athleteId } });

    await prisma.app_user.delete({ where: { id: userId } });
    createdUserIds.splice(createdUserIds.indexOf(userId), 1);

    expect(await prisma.coach_profile.findUnique({ where: { id: coachId } })).toBeNull();
    expect(await prisma.coach_athlete.findMany({ where: { coach_id: coachId } })).toHaveLength(0);
    expect(await prisma.coach_group.findUnique({ where: { id: group.id } })).toBeNull();
    expect(await prisma.coach_group_athlete.findMany({ where: { group_id: group.id } })).toHaveLength(0);
  });
});
