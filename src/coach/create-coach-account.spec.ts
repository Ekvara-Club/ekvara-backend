import "dotenv/config";
import * as argon2 from "argon2";
import { PrismaService } from "../prisma/prisma.service";
import { createCoachAccount } from "./create-coach-account";

// Intégration Postgres réelle : fixtures jetables (email/club uniques par
// run), nettoyées en afterAll (cascade app_user -> coach_profile, puis club).
describe("createCoachAccount (intégration Postgres)", () => {
  let prisma: PrismaService;
  const runId = Date.now();
  const clubName = `Club test create-coach ${runId}`;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.app_user.deleteMany({ where: { email: { startsWith: `test-fixture-create-coach-${runId}` } } });
    await prisma.club.deleteMany({ where: { nom: clubName } });
    await prisma.$disconnect();
  });

  it("crée app_user (email normalisé, hash argon2id vérifiable), club et coach_profile ; club réutilisé ; email en double refusé", async () => {
    const result = await createCoachAccount(prisma, {
      email: `  Test-Fixture-Create-Coach-${runId}-a@Test.fr `,
      password: "motdepasse-solide",
      prenom: "Kaïs",
      nom: "Dilmi",
      clubName,
      clubVille: "Eaubonne",
    });

    const user = await prisma.app_user.findUniqueOrThrow({
      where: { id: result.userId },
      include: { coach_profile: true },
    });
    expect(user.email).toBe(`test-fixture-create-coach-${runId}-a@test.fr`);
    expect(await argon2.verify(user.password_hash!, "motdepasse-solide")).toBe(true);
    expect(user.coach_profile?.club_id).toBe(result.clubId);

    const second = await createCoachAccount(prisma, {
      email: `test-fixture-create-coach-${runId}-b@test.fr`,
      password: "motdepasse-solide",
      prenom: "A",
      nom: "B",
      clubName,
    });
    expect(second.clubId).toBe(result.clubId);

    await expect(
      createCoachAccount(prisma, {
        email: `test-fixture-create-coach-${runId}-a@test.fr`,
        password: "autre-mot-de-passe",
        prenom: "X",
        nom: "Y",
        clubName,
      }),
    ).rejects.toThrow(/existe déjà/);
  });

  it("mot de passe trop court ou email invalide : refusé avant toute écriture", async () => {
    await expect(
      createCoachAccount(prisma, { email: `test-fixture-create-coach-${runId}-c@test.fr`, password: "court", prenom: "A", nom: "B", clubName }),
    ).rejects.toThrow(/entre 8 et 255/);
    await expect(
      createCoachAccount(prisma, { email: "pas-un-email", password: "motdepasse-solide", prenom: "A", nom: "B", clubName }),
    ).rejects.toThrow(/Email invalide/);
    expect(await prisma.app_user.count({ where: { email: `test-fixture-create-coach-${runId}-c@test.fr` } })).toBe(0);
  });
});
