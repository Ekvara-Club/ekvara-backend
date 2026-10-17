import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { AdminAuditLogger } from "./admin-audit.logger";
import { AdminSessionsRepository } from "./admin-sessions.repository";
import { ADMIN_COOKIE_NAME, ADMIN_CSRF_HEADER, ADMIN_SAFE_METHODS, AdminJwtPayload } from "./admin-session";
import { ADMIN_JWT, ADMIN_USER_IDS } from "./admin-tokens";

const AUTH_REQUIRED_MESSAGE = "Session d'administration requise";
const FORBIDDEN_MESSAGE = "Accès réservé à l'administration";
const CSRF_MESSAGE = "Jeton CSRF manquant ou invalide";

// Seul guard d'autorisation des routes /admin/* (sauf /admin/auth/login),
// appliqué au niveau de chaque contrôleur admin. Ne lit QUE le cookie admin
// (jamais les cookies Athlete/Coach), vérifié avec le secret et l'audience
// admin. À chaque requête, et pas seulement à la connexion :
// - 401 : pas de session admin valide (absente, falsifiée, expirée, ou
//         session serveur admin_session inconnue, révoquée ou expirée —
//         une déconnexion invalide donc aussi un JWT copié auparavant) ;
// - 403 : identité qui n'est plus dans ADMIN_USER_IDS (révocation par
//         configuration), ou méthode non-sûre sans le jeton CSRF de la session.
// L'origine de la requête (CORS, en-tête Origin) n'intervient jamais ici.
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @Inject(ADMIN_JWT) private readonly adminJwt: JwtService,
    @Inject(ADMIN_USER_IDS) private readonly adminUserIds: ReadonlySet<string>,
    private readonly sessions: AdminSessionsRepository,
    private readonly audit: AdminAuditLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token: unknown = request.cookies?.[ADMIN_COOKIE_NAME];
    if (!token || typeof token !== "string") {
      throw new UnauthorizedException(AUTH_REQUIRED_MESSAGE);
    }

    let payload: AdminJwtPayload;
    try {
      payload = this.adminJwt.verify<AdminJwtPayload>(token);
    } catch {
      throw new UnauthorizedException(AUTH_REQUIRED_MESSAGE);
    }
    if (
      typeof payload.sub !== "string" ||
      typeof payload.sid !== "string" ||
      typeof payload.csrf !== "string" ||
      typeof payload.exp !== "number"
    ) {
      throw new UnauthorizedException(AUTH_REQUIRED_MESSAGE);
    }

    if (!this.adminUserIds.has(payload.sub.toLowerCase())) {
      this.audit.denied("admin.access.denied", { userId: payload.sub, reason: "not_admin", path: request.path });
      throw new ForbiddenException(FORBIDDEN_MESSAGE);
    }

    // Session serveur : relue à CHAQUE requête (aucun cache), donc partagée
    // par toutes les instances et révoquée immédiatement partout.
    const session = await this.sessions.findById(payload.sid);
    const reason = !session
      ? "session_unknown"
      : session.app_user_id.toLowerCase() !== payload.sub.toLowerCase()
        ? "session_mismatch"
        : session.revoked_at
          ? "session_revoked"
          : session.expires_at.getTime() <= Date.now()
            ? "session_expired"
            : null;
    if (reason) {
      this.audit.denied("admin.access.denied", { userId: payload.sub, reason, path: request.path });
      throw new UnauthorizedException(AUTH_REQUIRED_MESSAGE);
    }

    if (!ADMIN_SAFE_METHODS.has(request.method.toUpperCase())) {
      const header = request.headers[ADMIN_CSRF_HEADER];
      if (typeof header !== "string" || !safeEqual(header, payload.csrf)) {
        this.audit.denied("admin.access.denied", { userId: payload.sub, reason: "csrf", path: request.path });
        throw new ForbiddenException(CSRF_MESSAGE);
      }
    }

    request.admin = {
      userId: payload.sub,
      sessionId: payload.sid,
      csrfToken: payload.csrf,
      expiresAt: new Date(Math.min(payload.exp * 1000, session!.expires_at.getTime())),
    };
    return true;
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
