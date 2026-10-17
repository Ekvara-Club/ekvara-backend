import { Inject, Injectable } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

export const ADMIN_THROTTLE_SECRET = Symbol("ADMIN_THROTTLE_SECRET");

// Limites des tentatives de connexion admin, partagées par TOUTES les
// instances (compteurs en base, jamais en mémoire : sur Vercel chaque
// instance a sa propre mémoire, recyclée à tout moment).
// - par IP : toute tentative compte (5 / minute) — freine le balayage ;
// - par compte : seuls les échecs comptent (10 / 15 minutes) — freine une
//   attaque répartie sur plusieurs IP ; réinitialisé à la connexion réussie.
//   Contrepartie assumée : un tiers peut retarder de 15 min la connexion du
//   compte visé (un seul administrateur, aucune donnée exposée).
export const ADMIN_LOGIN_LIMITS = {
  ip: { limit: 5, windowSeconds: 60 },
  account: { limit: 10, windowSeconds: 15 * 60 },
} as const;

const PURGE_AFTER = "1 day";

export interface ThrottleState {
  hits: number;
  retryAfterSeconds: number;
}

@Injectable()
export class AdminLoginThrottle {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ADMIN_THROTTLE_SECRET) private readonly secret: string,
  ) {}

  // Clé non réversible : aucune IP ni adresse e-mail stockée en clair.
  key(kind: "ip" | "account", value: string): string {
    return `${kind}:${createHmac("sha256", this.secret).update(`${kind}:${value}`).digest("hex")}`;
  }

  // Incrément atomique en fenêtre fixe : INSERT ... ON CONFLICT verrouille la
  // ligne, deux instances concurrentes ne peuvent pas lire le même compteur.
  // Toutes les expressions SET lisent l'ANCIENNE ligne.
  async hit(key: string, windowSeconds: number): Promise<ThrottleState> {
    const rows = await this.prisma.$queryRaw<{ hits: number; retry_after: number }[]>`
      INSERT INTO admin_login_attempt (key, window_start, hits)
      VALUES (${key}, now(), 1)
      ON CONFLICT (key) DO UPDATE SET
        hits = CASE WHEN admin_login_attempt.window_start <= now() - make_interval(secs => ${windowSeconds})
                    THEN 1 ELSE admin_login_attempt.hits + 1 END,
        window_start = CASE WHEN admin_login_attempt.window_start <= now() - make_interval(secs => ${windowSeconds})
                            THEN now() ELSE admin_login_attempt.window_start END
      RETURNING hits,
        GREATEST(1, CEIL(EXTRACT(EPOCH FROM (window_start + make_interval(secs => ${windowSeconds}) - now()))))::int AS retry_after`;
    return { hits: rows[0].hits, retryAfterSeconds: rows[0].retry_after };
  }

  async peek(key: string, windowSeconds: number): Promise<ThrottleState> {
    const rows = await this.prisma.$queryRaw<{ hits: number; retry_after: number }[]>`
      SELECT hits,
        GREATEST(1, CEIL(EXTRACT(EPOCH FROM (window_start + make_interval(secs => ${windowSeconds}) - now()))))::int AS retry_after
      FROM admin_login_attempt
      WHERE key = ${key} AND window_start > now() - make_interval(secs => ${windowSeconds})`;
    return rows.length > 0 ? { hits: rows[0].hits, retryAfterSeconds: rows[0].retry_after } : { hits: 0, retryAfterSeconds: 0 };
  }

  async reset(key: string): Promise<void> {
    await this.prisma.$executeRaw`DELETE FROM admin_login_attempt WHERE key = ${key}`;
  }

  async purgeStale(): Promise<void> {
    await this.prisma.$executeRaw`DELETE FROM admin_login_attempt WHERE window_start < now() - ${PURGE_AFTER}::interval`;
  }
}
