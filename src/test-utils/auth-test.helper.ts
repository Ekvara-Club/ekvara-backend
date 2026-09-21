import { JwtModule, JwtService } from "@nestjs/jwt";
import type { DynamicModule } from "@nestjs/common";
import type { SignOptions } from "jsonwebtoken";
import { AUTH_COOKIE_NAMES, type AppContext } from "../auth/auth.cookie";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// Secret dédié aux tests uniquement, jamais utilisé en dehors des specs.
export const TEST_JWT_SECRET = "test-jwt-secret-for-specs-only";

export function testJwtModule(): DynamicModule {
  return JwtModule.register({ secret: TEST_JWT_SECRET, signOptions: { expiresIn: "1h" } });
}

export function signTestToken(payload: JwtPayload, expiresIn?: string): string {
  const jwtService = new JwtService({ secret: TEST_JWT_SECRET });
  return jwtService.sign(
    payload,
    expiresIn ? { expiresIn: expiresIn as SignOptions["expiresIn"] } : undefined,
  );
}

// `context` = application qui porte la session (cookie distinct par app) ;
// "athlete" par défaut, comme le contexte par défaut du backend quand
// X-Ekvara-App est absent (voir resolveAppContext).
export function authCookieHeader(token: string, context: AppContext = "athlete"): string {
  return `${AUTH_COOKIE_NAMES[context]}=${token}`;
}
