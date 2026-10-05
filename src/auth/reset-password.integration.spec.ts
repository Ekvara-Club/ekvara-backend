import "dotenv/config";
import * as argon2 from "argon2";
import { PrismaService } from "../prisma/prisma.service";
import { resetPassword } from "./reset-password";

describe("resetPassword (intégration Postgres)", () => {
  let prisma: PrismaService;
  const runId = Date.now();
  const email = `test-fixture-reset-${runId}@test.fr`;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.app_user.create({ data: { email, password_hash: await argon2.hash("ancien-mot-de-passe", { type: argon2.argon2id }) } });
  });

  afterAll(async () => {
    await prisma.app_user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  it("remplace le hash (email insensible à la casse) : nouveau mot de passe valide, ancien refusé", async () => {
    await resetPassword(prisma, `  TEST-FIXTURE-RESET-${runId}@Test.fr `, "nouveau-mot-de-passe");

    const user = await prisma.app_user.findUniqueOrThrow({ where: { email } });
    expect(await argon2.verify(user.password_hash!, "nouveau-mot-de-passe")).toBe(true);
    expect(await argon2.verify(user.password_hash!, "ancien-mot-de-passe")).toBe(false);
  });

  it("mot de passe trop court ou compte inconnu : refusé, rien modifié", async () => {
    const before = (await prisma.app_user.findUniqueOrThrow({ where: { email } })).password_hash;

    await expect(resetPassword(prisma, email, "court")).rejects.toThrow(/entre 8 et 255/);
    await expect(resetPassword(prisma, `inconnu-${runId}@test.fr`, "nouveau-mot-de-passe")).rejects.toThrow(/Aucun compte/);

    expect((await prisma.app_user.findUniqueOrThrow({ where: { email } })).password_hash).toBe(before);
  });
});
