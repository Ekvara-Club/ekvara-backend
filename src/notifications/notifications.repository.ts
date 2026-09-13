import { Injectable } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationInsertRow } from "./notifications.util";

// Accepte indifféremment le PrismaService global ou un client de transaction
// (`tx` d'un `$transaction`) : les repositories coach (trainings, exercises)
// insèrent des notifications DANS leur propre transaction existante pour
// rester atomiques avec la mutation métier (voir CoachTrainingsRepository),
// tandis que goals/weight-targets (non transactionnels aujourd'hui, voir
// rapport final "compromis transactionnel") appellent avec le PrismaService
// tel quel.
export type PrismaClientOrTx = PrismaService | Prisma.TransactionClient;

const LIST_SELECT = {
  id: true,
  actor_user_id: true,
  type: true,
  title: true,
  message: true,
  resource_type: true,
  resource_id: true,
  is_read: true,
  created_at: true,
  read_at: true,
} satisfies Prisma.notificationSelect;

export type NotificationRow = Prisma.notificationGetPayload<{ select: typeof LIST_SELECT }>;

@Injectable()
export class NotificationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Résout athlete.id -> app_user.id (recipient_user_id réel). Un athlete
  // sans app_user exploitable est structurellement impossible (athlete.user_id
  // est NOT NULL + unique, FK onDelete: Cascade vers app_user — voir
  // schema.prisma) : aucune ligne manquante à gérer défensivement ici, le
  // Map construit par l'appelant reflète simplement 1:1 les athleteIds reçus.
  resolveAthleteUserIds(
    client: PrismaClientOrTx,
    athleteIds: string[],
  ): Promise<{ id: string; user_id: string }[]> {
    if (athleteIds.length === 0) {
      return Promise.resolve([]);
    }
    return client.athlete.findMany({
      where: { id: { in: [...new Set(athleteIds)] } },
      select: { id: true, user_id: true },
    });
  }

  createMany(client: PrismaClientOrTx, rows: NotificationInsertRow[]): Promise<{ count: number }> {
    if (rows.length === 0) {
      return Promise.resolve({ count: 0 });
    }
    return client.notification.createMany({ data: rows });
  }

  findForRecipient(
    recipientUserId: string,
    context: string | undefined,
    page: number,
    limit: number,
  ): Promise<NotificationRow[]> {
    return this.prisma.notification.findMany({
      where: { recipient_user_id: recipientUserId, ...(context ? { context } : {}) },
      select: LIST_SELECT,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  countForRecipient(recipientUserId: string, context: string | undefined): Promise<number> {
    return this.prisma.notification.count({
      where: { recipient_user_id: recipientUserId, ...(context ? { context } : {}) },
    });
  }

  countUnreadForRecipient(recipientUserId: string, context: string | undefined): Promise<number> {
    return this.prisma.notification.count({
      where: { recipient_user_id: recipientUserId, is_read: false, ...(context ? { context } : {}) },
    });
  }

  findOwned(notificationId: string, recipientUserId: string): Promise<{ id: string } | null> {
    return this.prisma.notification.findFirst({
      where: { id: notificationId, recipient_user_id: recipientUserId },
      select: { id: true },
    });
  }

  markRead(notificationId: string): Promise<void> {
    return this.prisma.notification
      .update({ where: { id: notificationId }, data: { is_read: true, read_at: new Date() } })
      .then(() => undefined);
  }

  async markAllRead(recipientUserId: string, context: string | undefined): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: { recipient_user_id: recipientUserId, is_read: false, ...(context ? { context } : {}) },
      data: { is_read: true, read_at: new Date() },
    });
    return result.count;
  }
}
