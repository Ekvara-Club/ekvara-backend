import "dotenv/config";
import * as argon2 from "argon2";
import { UnauthorizedException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { describeOnTestDatabase } from "../test-utils/test-database";
import { AdminAuditLogger } from "./admin-audit.logger";
import { AdminAuthService } from "./admin-auth.service";
import { createAdminJwtService } from "./admin-tokens";

// Connexion admin contre un vrai Postgres (vrais hashes argon2, vraie lecture
// app_user) — UNIQUEMENT sur la base de test isolée (npm run test:testdb),
// ignorée sinon. Utilisateurs jetables, supprimés en afterAll. La connexion
// ne doit écrire AUCUNE ligne en base.
describeOnTestDatabase("Connexion EkvaraAdmin (intégration Postgres, base de test)", () => {
  let prisma: PrismaService;
  const runId = Date.now();
  const password = "motdepasse-integration";
  let adminId: string;
  let otherId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const admin = await prisma.app_user.create({
      data: { email: `admin-${runId}@test.ekvara.fr`, password_hash: passwordHash, nom: "Admin", prenom: "Test" },
    });
    const other = await prisma.app_user.create({
      data: { email: `other-${runId}@test.ekvara.fr`, password_hash: passwordHash, nom: "Other", prenom: "Test" },
    });
    adminId = admin.id;
    otherId = other.id;
  });

  afterAll(async () => {
    await prisma.app_user.deleteMany({ where: { id: { in: [adminId, otherId] } } });
    await prisma.$disconnect();
  });

  function service() {
    return new AdminAuthService(prisma, createAdminJwtService("integration-secret"), new Set([adminId]), new AdminAuditLogger());
  }

  it("administrateur : session signée, profil lu en base, aucune écriture", async () => {
    const before = await prisma.app_user.findUniqueOrThrow({ where: { id: adminId } });
    const { token, session } = await service().login({ email: `ADMIN-${runId}@test.ekvara.fr`, password });
    const after = await prisma.app_user.findUniqueOrThrow({ where: { id: adminId } });

    expect(token).toEqual(expect.any(String));
    expect(session.user).toEqual({ id: adminId, email: `admin-${runId}@test.ekvara.fr`, nom: "Admin", prenom: "Test" });
    expect(after).toEqual(before);
  });

  it("compte existant non administrateur -> 401", async () => {
    await expect(service().login({ email: `other-${runId}@test.ekvara.fr`, password })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("mauvais mot de passe -> 401", async () => {
    await expect(service().login({ email: `admin-${runId}@test.ekvara.fr`, password: "faux" })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("session d'un compte supprimé depuis -> 401", async () => {
    const ghost = new AdminAuthService(prisma, createAdminJwtService("integration-secret"), new Set(), new AdminAuditLogger());
    await expect(
      ghost.getSession({ userId: "00000000-0000-4000-8000-000000000000", csrfToken: "x", expiresAt: new Date() }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
