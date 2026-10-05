import { Module } from "@nestjs/common";
import { AuthGuardsModule } from "../auth/auth-guards.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AthleteWtLinkController, CoachWtLinkController } from "./wt-links.controller";
import { WtLinksService } from "./wt-links.service";

@Module({
  imports: [AuthGuardsModule, NotificationsModule],
  controllers: [AthleteWtLinkController, CoachWtLinkController],
  providers: [WtLinksService],
})
export class WtLinksModule {}
