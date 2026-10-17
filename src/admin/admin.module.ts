import { Module } from "@nestjs/common";
import { CompetitionsModule } from "../competitions/competitions.module";
import { InternationalRepository } from "../international/international.repository";
import { AdminAuditLogger } from "./admin-audit.logger";
import { AdminAthletesController } from "./athletes/admin-athletes.controller";
import { AdminAthletesRepository } from "./athletes/admin-athletes.repository";
import { AdminAthletesService } from "./athletes/admin-athletes.service";
import { AdminEntriesController } from "./entries/admin-entries.controller";
import { AdminEntriesRepository } from "./entries/admin-entries.repository";
import { AdminEntriesService } from "./entries/admin-entries.service";
import { AdminMatchesController } from "./matches/admin-matches.controller";
import { AdminMatchesRepository } from "./matches/admin-matches.repository";
import { AdminMatchesService } from "./matches/admin-matches.service";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminAuthService } from "./admin-auth.service";
import { AdminLoginThrottle } from "./admin-login-throttle";
import { AdminSessionsRepository } from "./admin-sessions.repository";
import { AdminGuard } from "./admin.guard";
import { AdminStatsController, AdminStatsService } from "./admin-stats.controller";
import { adminTokenProviders } from "./admin-tokens";
import { AdminCompetitionsController } from "./competitions/admin-competitions.controller";
import { AdminCompetitionsRepository } from "./competitions/admin-competitions.repository";
import { AdminCompetitionsService } from "./competitions/admin-competitions.service";

// Portail EkvaraAdmin (ticket "EkvaraAdmin V1"). Module additif : aucune
// dépendance vers AuthModule, aucun contrôleur existant modifié. Réutilise
// CompetitionsRepository (exporté par CompetitionsModule) et
// InternationalRepository (instance locale : InternationalModule n'est pas
// modifié) en lecture. Tous les contrôleurs métier sont sous
// @UseGuards(AdminGuard) au niveau classe (voir admin-routes.spec.ts).
@Module({
  // Limitation des connexions : AdminLoginThrottle (compteurs en base,
  // partagés entre instances), plus de ThrottlerModule en mémoire ici.
  imports: [CompetitionsModule],
  controllers: [
    AdminAuthController,
    AdminStatsController,
    AdminCompetitionsController,
    AdminAthletesController,
    AdminEntriesController,
    AdminMatchesController,
  ],
  providers: [
    ...adminTokenProviders,
    AdminAuditLogger,
    AdminGuard,
    AdminSessionsRepository,
    AdminLoginThrottle,
    AdminAuthService,
    AdminStatsService,
    AdminCompetitionsRepository,
    AdminCompetitionsService,
    InternationalRepository,
    AdminAthletesRepository,
    AdminAthletesService,
    AdminEntriesRepository,
    AdminEntriesService,
    AdminMatchesRepository,
    AdminMatchesService,
  ],
})
export class AdminModule {}
