import { Module } from "@nestjs/common";
import { InvitationsService } from "./invitations.service";
import { InvitationsRepository } from "./invitations.repository";

// Module feuille (ne dépend que de PrismaModule, global) : importé à la fois
// par AuthModule (validate() + redeem() dans /auth/register) et CoachModule
// (create/list/revoke sous /coach/invitations), sans jamais créer de cycle
// entre les deux — même raison d'être que WeightsModule/GoalsModule (voir
// coach.module.ts).
@Module({
  providers: [InvitationsService, InvitationsRepository],
  exports: [InvitationsService],
})
export class InvitationsModule {}
