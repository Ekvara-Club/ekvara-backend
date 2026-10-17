import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Les sessions expirées ou révoquées sont conservées un jour (traçabilité
// courte) puis purgées à la connexion suivante : aucune tâche planifiée.
const PURGE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface AdminSessionRow {
  app_user_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}

// Sessions d'administration persistées (table admin_session), partagées par
// toutes les instances : la révocation est effective immédiatement partout.
// Indépendant des sessions Athlete/Coach (JWT sans état, inchangés).
@Injectable()
export class AdminSessionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(appUserId: string, expiresAt: Date): Promise<string> {
    const session = await this.prisma.admin_session.create({
      data: { app_user_id: appUserId, expires_at: expiresAt },
      select: { id: true },
    });
    return session.id;
  }

  // Identifiant mal formé : null, jamais une erreur de base (401, pas 500).
  findById(id: string): Promise<AdminSessionRow | null> {
    if (!UUID_RE.test(id)) return Promise.resolve(null);
    return this.prisma.admin_session.findUnique({
      where: { id },
      select: { app_user_id: true, expires_at: true, revoked_at: true },
    });
  }

  async revoke(id: string): Promise<void> {
    if (!UUID_RE.test(id)) return;
    await this.prisma.admin_session.updateMany({ where: { id, revoked_at: null }, data: { revoked_at: new Date() } });
  }

  async purgeStale(now: Date = new Date()): Promise<void> {
    const before = new Date(now.getTime() - PURGE_AFTER_MS);
    await this.prisma.admin_session.deleteMany({
      where: { OR: [{ expires_at: { lt: before } }, { revoked_at: { lt: before } }] },
    });
  }
}
