import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AdminAuditLogger } from "./admin-audit.logger";
import { AdminContext, AdminJwtPayload } from "./admin-session";
import { ADMIN_JWT, ADMIN_USER_IDS } from "./admin-tokens";
import { AdminLoginDto } from "./dto/admin-login.dto";

// Même message quel que soit le motif (email inconnu, mot de passe faux,
// compte non administrateur) : ne jamais révéler quels comptes existent ni
// lesquels sont administrateurs. Le motif réel n'est écrit que dans le journal.
const INVALID_CREDENTIALS_MESSAGE = "Identifiants invalides ou accès non autorisé";
const SESSION_REQUIRED_MESSAGE = "Session d'administration requise";

export interface AdminSessionView {
  user: { id: string; email: string; nom: string | null; prenom: string | null };
  csrfToken: string;
  expiresAt: string;
}

@Injectable()
export class AdminAuthService {
  // Hash factice calculé une seule fois : un email inconnu coûte une
  // vérification argon2 comme un email connu (pas de canal temporel).
  private dummyHash?: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ADMIN_JWT) private readonly adminJwt: JwtService,
    @Inject(ADMIN_USER_IDS) private readonly adminUserIds: ReadonlySet<string>,
    private readonly audit: AdminAuditLogger,
  ) {}

  // Ordre imposé (ticket D1) : identifiants vérifiés, PUIS éligibilité admin,
  // et seulement ensuite signature d'une session. Un compte non administrateur
  // ne reçoit jamais de jeton, même valide par ailleurs pour Athlete/Coach.
  async login(dto: AdminLoginDto): Promise<{ token: string; session: AdminSessionView }> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.app_user.findUnique({
      where: { email },
      select: { id: true, email: true, nom: true, prenom: true, password_hash: true },
    });

    const passwordValid = await this.verifyPassword(user?.password_hash ?? null, dto.password);
    if (!user || !passwordValid) {
      this.audit.denied("admin.login.denied", { userId: user?.id ?? null, reason: "invalid_credentials" });
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    if (!this.adminUserIds.has(user.id.toLowerCase())) {
      this.audit.denied("admin.login.denied", { userId: user.id, reason: "not_admin" });
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    const csrfToken = randomBytes(32).toString("base64url");
    const token = this.adminJwt.sign({ sub: user.id, csrf: csrfToken } satisfies AdminJwtPayload);
    const exp = (this.adminJwt.decode(token) as { exp: number }).exp;

    this.audit.record("admin.login.success", { userId: user.id });
    return {
      token,
      session: {
        user: { id: user.id, email: user.email, nom: user.nom, prenom: user.prenom },
        csrfToken,
        expiresAt: new Date(exp * 1000).toISOString(),
      },
    };
  }

  // Relu en base à chaque appel : un compte supprimé perd sa session même si
  // son jeton n'a pas encore expiré.
  async getSession(admin: AdminContext): Promise<AdminSessionView> {
    const user = await this.prisma.app_user.findUnique({
      where: { id: admin.userId },
      select: { id: true, email: true, nom: true, prenom: true },
    });
    if (!user) {
      throw new UnauthorizedException(SESSION_REQUIRED_MESSAGE);
    }
    return { user, csrfToken: admin.csrfToken, expiresAt: admin.expiresAt.toISOString() };
  }

  recordLogout(admin: AdminContext): void {
    this.audit.record("admin.logout", { userId: admin.userId });
  }

  private async verifyPassword(hash: string | null, password: string): Promise<boolean> {
    if (!hash) {
      this.dummyHash ??= argon2.hash("ekvara-admin-dummy-password", { type: argon2.argon2id });
      await argon2.verify(await this.dummyHash, password).catch(() => false);
      return false;
    }
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
}
