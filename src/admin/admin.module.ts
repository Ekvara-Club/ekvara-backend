import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { CompetitionsModule } from "../competitions/competitions.module";
import { AdminAuditLogger } from "./admin-audit.logger";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminAuthService } from "./admin-auth.service";
import { AdminGuard } from "./admin.guard";
import { AdminStatsController, AdminStatsService } from "./admin-stats.controller";
import { adminTokenProviders } from "./admin-tokens";
import { AdminCompetitionsController } from "./competitions/admin-competitions.controller";
import { AdminCompetitionsRepository } from "./competitions/admin-competitions.repository";
import { AdminCompetitionsService } from "./competitions/admin-competitions.service";

// Plus strict que /auth (8/min) : un seul compte légitime, aucune raison de
// tenter plus de 5 connexions par minute.
const ADMIN_LOGIN_THROTTLE_TTL_MS = 60_000;
const ADMIN_LOGIN_THROTTLE_LIMIT = 5;

// Portail EkvaraAdmin (ticket "EkvaraAdmin V1"). Module additif : aucune
// dépendance vers AuthModule, aucun contrôleur existant modifié. Réutilise
// CompetitionsRepository (exporté par CompetitionsModule) en lecture. Tous
// les contrôleurs métier sont sous @UseGuards(AdminGuard) au niveau classe
// (voir admin-routes.spec.ts).
@Module({
  imports: [CompetitionsModule, ThrottlerModule.forRoot([{ ttl: ADMIN_LOGIN_THROTTLE_TTL_MS, limit: ADMIN_LOGIN_THROTTLE_LIMIT }])],
  controllers: [AdminAuthController, AdminStatsController, AdminCompetitionsController],
  providers: [
    ...adminTokenProviders,
    AdminAuditLogger,
    AdminGuard,
    AdminAuthService,
    AdminStatsService,
    AdminCompetitionsRepository,
    AdminCompetitionsService,
  ],
})
export class AdminModule {}
