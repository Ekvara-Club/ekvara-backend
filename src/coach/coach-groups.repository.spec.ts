import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { CoachGroupsRepository } from "./coach-groups.repository";

// Test d'intégration contre la vraie base Postgres locale : contraintes
// uniques (coach_group(coach_id, name), coach_group_athlete(group_id,
// athlete_id)) et cascade DELETE group -> memberships. Fixtures jetables
// nettoyées en afterEach via cascade sur app_user (voir CoachRepository.spec
// pour le même principe).
describe("CoachGroupsRepository (intégration Postgres)", () => {
  let prisma: PrismaService;
  let repository: CoachGroupsRepository;
  const runId = Date.now();
  const createdUserIds: string[] = [];
  let counter = 0;

  beforeAll(() => {
    prisma = new PrismaService();
    repository = new CoachGroupsRepository(prisma);
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
      data: { email: `test-fixture-cg-coach-${runId}-${counter}@test.fr`, nom: "Coach", prenom: `F${counter}` },
    });
    createdUserIds.push(user.id);
    const profile = await prisma.coach_profile.create({ data: { user_id: user.id } });
    return profile.id;
  }

  async function makeAthlete(): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-cg-athlete-${runId}-${counter}@test.fr`, nom: "Athlete", prenom: `F${counter}` },
    });
    createdUserIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id } });
    return athlete.id;
  }

  describe("coach_group", () => {
    it("contrainte unique (coach_id, name) réellement appliquée par Postgres", async () => {
      const coachId = await makeCoach();
      await repository.createGroup(coachId, "Élite");

      await expect(repository.createGroup(coachId, "Élite")).rejects.toThrow();
    });

    it("deux coachs différents peuvent chacun avoir un groupe du même nom", async () => {
      const coachAId = await makeCoach();
      const coachBId = await makeCoach();

      await expect(repository.createGroup(coachAId, "Élite")).resolves.toBeDefined();
      await expect(repository.createGroup(coachBId, "Élite")).resolves.toBeDefined();
    });

    it("comparaison de nom case-sensitive (comportement par défaut Postgres, non normalisé)", async () => {
      const coachId = await makeCoach();
      await repository.createGroup(coachId, "Elite");

      // Casse différente : pas de collision, la contrainte unique ne s'applique pas.
      await expect(repository.createGroup(coachId, "ELITE")).resolves.toBeDefined();
    });

    it("findOwnership renvoie coach_id pour CoachGroupOwnershipGuard, null si inconnu", async () => {
      const coachId = await makeCoach();
      const group = await repository.createGroup(coachId, "Élite");

      expect((await repository.findOwnership(group.id))?.coach_id).toBe(coachId);
      expect(await repository.findOwnership("00000000-0000-4000-8000-000000000000")).toBeNull();
    });

    it("findGroupsForCoach expose athleteCount via _count.members", async () => {
      const coachId = await makeCoach();
      const group = await repository.createGroup(coachId, "Élite");
      const athleteId = await makeAthlete();
      await repository.addMember(group.id, athleteId);

      const groups = await repository.findGroupsForCoach(coachId);

      expect(groups).toHaveLength(1);
      expect(groups[0]._count.members).toBe(1);
    });

    it("suppression du groupe supprime en cascade ses memberships (onDelete: Cascade), jamais coach_athlete", async () => {
      const coachId = await makeCoach();
      const athleteId = await makeAthlete();
      await prisma.coach_athlete.create({ data: { coach_id: coachId, athlete_id: athleteId } });
      const group = await repository.createGroup(coachId, "Élite");
      await repository.addMember(group.id, athleteId);

      await repository.deleteGroup(group.id);

      expect(await prisma.coach_group_athlete.findMany({ where: { group_id: group.id } })).toHaveLength(0);
      // coach_athlete (autorisation globale) doit survivre à la suppression du groupe.
      const link = await prisma.coach_athlete.findUnique({
        where: { coach_id_athlete_id: { coach_id: coachId, athlete_id: athleteId } },
      });
      expect(link).not.toBeNull();
    });
  });

  describe("coach_group_athlete", () => {
    it("contrainte unique (group_id, athlete_id) réellement appliquée par Postgres", async () => {
      const coachId = await makeCoach();
      const group = await repository.createGroup(coachId, "Élite");
      const athleteId = await makeAthlete();

      await repository.addMember(group.id, athleteId);
      await expect(repository.addMember(group.id, athleteId)).rejects.toThrow();
    });

    it("membershipExists reflète l'état réel en base", async () => {
      const coachId = await makeCoach();
      const group = await repository.createGroup(coachId, "Élite");
      const athleteId = await makeAthlete();

      expect(await repository.membershipExists(group.id, athleteId)).toBe(false);
      await repository.addMember(group.id, athleteId);
      expect(await repository.membershipExists(group.id, athleteId)).toBe(true);
    });

    it("findGroupDetail renvoie les athlètes membres avec leur app_user (sans password_hash)", async () => {
      const coachId = await makeCoach();
      const group = await repository.createGroup(coachId, "Élite");
      const athleteId = await makeAthlete();
      await repository.addMember(group.id, athleteId);

      const detail = await repository.findGroupDetail(group.id);

      expect(detail?.members).toHaveLength(1);
      expect(detail?.members[0].athlete.id).toBe(athleteId);
      expect(detail?.members[0].athlete.app_user).not.toHaveProperty("password_hash");
    });

    it("removeMember retire uniquement la ligne visée, isole les autres groupes", async () => {
      const coachId = await makeCoach();
      const groupA = await repository.createGroup(coachId, "Élite");
      const groupB = await repository.createGroup(coachId, "Juniors");
      const athleteId = await makeAthlete();
      await repository.addMember(groupA.id, athleteId);
      await repository.addMember(groupB.id, athleteId);

      await repository.removeMember(groupA.id, athleteId);

      expect(await repository.membershipExists(groupA.id, athleteId)).toBe(false);
      expect(await repository.membershipExists(groupB.id, athleteId)).toBe(true);
    });
  });
});
