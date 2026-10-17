import { JwtService } from "@nestjs/jwt";
import type { SignOptions } from "jsonwebtoken";
import { deriveAdminJwtSecret, deriveAdminThrottleSecret, resolveAdminUserIds } from "./admin-config";
import { ADMIN_THROTTLE_SECRET } from "./admin-login-throttle";
import { ADMIN_SESSION_TTL_SECONDS, ADMIN_TOKEN_AUDIENCE } from "./admin-session";

// Jetons d'injection propres au module admin : jamais le JwtService partagé
// d'AuthGuardsModule (secret différent), jamais une lecture d'env dispersée.
export const ADMIN_JWT = Symbol("ADMIN_JWT");
export const ADMIN_USER_IDS = Symbol("ADMIN_USER_IDS");

export function createAdminJwtService(jwtSecret: string): JwtService {
  return new JwtService({
    secret: deriveAdminJwtSecret(jwtSecret),
    signOptions: { expiresIn: ADMIN_SESSION_TTL_SECONDS as SignOptions["expiresIn"], audience: ADMIN_TOKEN_AUDIENCE },
    verifyOptions: { audience: ADMIN_TOKEN_AUDIENCE },
  });
}

function requireJwtSecret(): string {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("JWT_SECRET est requis (voir .env.example). Aucun secret de repli n'est utilisé.");
  }
  return jwtSecret;
}

export const adminTokenProviders = [
  { provide: ADMIN_JWT, useFactory: () => createAdminJwtService(requireJwtSecret()) },
  { provide: ADMIN_THROTTLE_SECRET, useFactory: () => deriveAdminThrottleSecret(requireJwtSecret()) },
  { provide: ADMIN_USER_IDS, useFactory: () => resolveAdminUserIds() },
];
