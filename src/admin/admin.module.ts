import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { AdminAuditLogger } from "./admin-audit.logger";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminAuthService } from "./admin-auth.service";
import { AdminGuard } from "./admin.guard";
import { adminTokenProviders } from "./admin-tokens";

// Plus strict que /auth (8/min) : un seul compte légitime, aucune raison de
// tenter plus de 5 connexions par minute.
const ADMIN_LOGIN_THROTTLE_TTL_MS = 60_000;
const ADMIN_LOGIN_THROTTLE_LIMIT = 5;

// Portail EkvaraAdmin (ticket "EkvaraAdmin V1"). Module additif : aucune
// dépendance vers AuthModule/AuthGuardsModule, aucun contrôleur existant
// modifié. Les contrôleurs métier des phases suivantes s'ajouteront ici, tous
// sous @UseGuards(AdminGuard) au niveau classe (voir admin-routes.spec.ts).
@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: ADMIN_LOGIN_THROTTLE_TTL_MS, limit: ADMIN_LOGIN_THROTTLE_LIMIT }])],
  controllers: [AdminAuthController],
  providers: [...adminTokenProviders, AdminAuditLogger, AdminGuard, AdminAuthService],
})
export class AdminModule {}
