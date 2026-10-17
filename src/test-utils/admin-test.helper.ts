import { randomUUID } from "node:crypto";
import type { JwtService } from "@nestjs/jwt";
import { ThrottleState } from "../admin/admin-login-throttle";
import { AdminSessionRow } from "../admin/admin-sessions.repository";
import { ADMIN_COOKIE_NAME } from "../admin/admin-session";

// Doublures EN MÉMOIRE pour les tests HTTP sans base (contrôleurs, guard).
// Le comportement réel, partagé entre instances, est couvert par
// admin-auth.integration.spec.ts sur ekvara_test.

export class InMemoryAdminSessions {
  readonly rows = new Map<string, AdminSessionRow>();

  async create(appUserId: string, expiresAt: Date): Promise<string> {
    const id = randomUUID();
    this.rows.set(id, { app_user_id: appUserId, expires_at: expiresAt, revoked_at: null });
    return id;
  }

  async findById(id: string): Promise<AdminSessionRow | null> {
    return this.rows.get(id) ?? null;
  }

  async revoke(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row && !row.revoked_at) row.revoked_at = new Date();
  }

  async purgeStale(): Promise<void> {}

  // Session active prête à l'emploi (tests de contrôleurs).
  activeFor(appUserId: string): string {
    const id = randomUUID();
    this.rows.set(id, { app_user_id: appUserId, expires_at: new Date(Date.now() + 3600_000), revoked_at: null });
    return id;
  }
}

export class InMemoryAdminLoginThrottle {
  readonly counters = new Map<string, { windowStart: number; hits: number }>();

  key(kind: "ip" | "account", value: string): string {
    return `${kind}:${value}`;
  }

  async hit(key: string, windowSeconds: number): Promise<ThrottleState> {
    const now = Date.now();
    const current = this.counters.get(key);
    const fresh = !current || current.windowStart <= now - windowSeconds * 1000;
    const next = fresh ? { windowStart: now, hits: 1 } : { windowStart: current.windowStart, hits: current.hits + 1 };
    this.counters.set(key, next);
    return { hits: next.hits, retryAfterSeconds: Math.max(1, Math.ceil((next.windowStart + windowSeconds * 1000 - now) / 1000)) };
  }

  async peek(key: string, windowSeconds: number): Promise<ThrottleState> {
    const current = this.counters.get(key);
    if (!current || current.windowStart <= Date.now() - windowSeconds * 1000) return { hits: 0, retryAfterSeconds: 0 };
    return { hits: current.hits, retryAfterSeconds: 1 };
  }

  async reset(key: string): Promise<void> {
    this.counters.delete(key);
  }

  async purgeStale(): Promise<void> {}
}

// Cookie admin signé pour une session active de `sessions`.
export function adminTestCookie(adminJwt: JwtService, sessions: InMemoryAdminSessions, userId: string, csrf: string): string {
  const sid = sessions.activeFor(userId);
  return `${ADMIN_COOKIE_NAME}=${adminJwt.sign({ sub: userId, sid, csrf })}`;
}
