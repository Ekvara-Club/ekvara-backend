import { Controller, Get, Param, ParseUUIDPipe, Patch, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { NotificationsService } from "./notifications.service";

// Aucun endpoint de création public (ticket "AUCUN ENDPOINT DE CRÉATION
// PUBLIC") : les notifications sont créées uniquement par les services
// métier coach (trainings, exercises, goals, weight-targets), jamais via une
// route HTTP. recipient_user_id/actor_user_id sont TOUJOURS dérivés de
// req.user (JwtAuthGuard) — jamais d'un id envoyé par le client, ce
// contrôleur ne fait que lire/marquer les notifications du destinataire
// authentifié (aucun guard d'ownership dédié nécessaire : l'appartenance est
// filtrée directement par recipient_user_id = req.user.sub, voir
// NotificationsService).
@Controller("notifications")
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  findAll(@Req() req: Request, @Query("context") context?: string, @Query("page") page?: string, @Query("limit") limit?: string) {
    return this.notificationsService.findForUser(req.user!.sub, context, page, limit);
  }

  @Get("unread-count")
  unreadCount(@Req() req: Request, @Query("context") context?: string) {
    return this.notificationsService.getUnreadCount(req.user!.sub, context);
  }

  @Patch(":notificationId/read")
  markRead(@Req() req: Request, @Param("notificationId", ParseUUIDPipe) notificationId: string) {
    return this.notificationsService.markRead(notificationId, req.user!.sub);
  }

  @Patch("read-all")
  markAllRead(@Req() req: Request, @Query("context") context?: string) {
    return this.notificationsService.markAllRead(req.user!.sub, context);
  }
}
