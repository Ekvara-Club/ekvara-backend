import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationRow, NotificationsRepository, PrismaClientOrTx } from "./notifications.repository";
import { NotificationContent, toNotificationRows } from "./notifications.util";
import { NOTIFICATION_CONTEXTS } from "./notification.constants";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export interface NotificationView {
  id: string;
  actorUserId: string | null;
  type: string;
  title: string;
  message: string | null;
  resourceType: string | null;
  resourceId: string | null;
  isRead: boolean;
  createdAt: Date;
  readAt: Date | null;
}

export interface PaginatedNotifications {
  items: NotificationView[];
  total: number;
  page: number;
  limit: number;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly repository: NotificationsRepository,
    private readonly prisma: PrismaService,
  ) {}

  // Point d'entrée pour les mutations NON transactionnelles (goals,
  // weight-targets — voir CoachAthleteGoalsController/CoachAthleteWeightsController
  // et le compromis documenté dans le rapport final). Les mutations déjà
  // transactionnelles (trainings, exercises) appellent NotificationsRepository
  // directement avec leur propre `tx` plutôt que ce service, pour rester
  // atomiques avec la mutation métier — voir CoachTrainingsRepository.
  async notifyAthletes(athleteIds: string[], content: NotificationContent, client?: PrismaClientOrTx): Promise<void> {
    if (athleteIds.length === 0) {
      return;
    }
    const target = client ?? this.prisma;
    const athletes = await this.repository.resolveAthleteUserIds(target, athleteIds);
    const rows = toNotificationRows(
      athletes.map((a) => a.user_id),
      content,
    );
    await this.repository.createMany(target, rows);
  }

  async findForUser(
    recipientUserId: string,
    contextParam: string | undefined,
    pageParam?: string,
    limitParam?: string,
  ): Promise<PaginatedNotifications> {
    const context = this.parseContext(contextParam);
    const page = this.parsePositiveInt(pageParam, "page", 1);
    const limit = this.parsePositiveInt(limitParam, "limit", DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const [rows, total] = await Promise.all([
      this.repository.findForRecipient(recipientUserId, context, page, limit),
      this.repository.countForRecipient(recipientUserId, context),
    ]);

    return { items: rows.map(toNotificationView), total, page, limit };
  }

  async getUnreadCount(recipientUserId: string, contextParam: string | undefined): Promise<{ count: number }> {
    const context = this.parseContext(contextParam);
    const count = await this.repository.countUnreadForRecipient(recipientUserId, context);
    return { count };
  }

  async markRead(notificationId: string, recipientUserId: string): Promise<void> {
    // Ownership strict dérivée du destinataire réel (req.user.sub), jamais
    // un recipientUserId envoyé par le client (voir ticket "SECURITY") —
    // même politique que CoachPreparationOwnershipGuard : un id inconnu ou
    // appartenant à un autre destinataire renvoie la même 404, sans
    // distinguer les deux cas.
    const owned = await this.repository.findOwned(notificationId, recipientUserId);
    if (!owned) {
      throw new NotFoundException(`Notification ${notificationId} introuvable`);
    }
    await this.repository.markRead(notificationId);
  }

  async markAllRead(recipientUserId: string, contextParam: string | undefined): Promise<{ updated: number }> {
    const context = this.parseContext(contextParam);
    const updated = await this.repository.markAllRead(recipientUserId, context);
    return { updated };
  }

  private parseContext(contextParam: string | undefined): string | undefined {
    if (contextParam === undefined) {
      return undefined;
    }
    if (!NOTIFICATION_CONTEXTS.includes(contextParam as (typeof NOTIFICATION_CONTEXTS)[number])) {
      throw new BadRequestException(`Le paramètre context doit être l'une des valeurs : ${NOTIFICATION_CONTEXTS.join(", ")}`);
    }
    return contextParam;
  }

  // Même convention que CompetitionsController.parsePositiveInt (page/limit
  // déjà établi côté /competitions) — dupliqué ici volontairement (parsing
  // HTTP local, pas une règle métier partagée), même précédent que
  // CoachTrainingsController.parseRange.
  private parsePositiveInt(value: string | undefined, name: string, fallback: number, max?: number): number {
    if (value === undefined) {
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || (max !== undefined && parsed > max)) {
      throw new BadRequestException(`Le paramètre ${name} doit être un entier entre 1 et ${max ?? "illimité"}`);
    }
    return parsed;
  }
}

function toNotificationView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    type: row.type,
    title: row.title,
    message: row.message,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    isRead: row.is_read,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}
