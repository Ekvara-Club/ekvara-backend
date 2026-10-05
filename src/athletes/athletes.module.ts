import { Module } from '@nestjs/common';
import { AuthGuardsModule } from '../auth/auth-guards.module';
import { AthletesController } from './athletes.controller';
import { AthletesService } from './athletes.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [AuthGuardsModule, NotificationsModule],
  controllers: [AthletesController],
  providers: [AthletesService],
  exports: [AthletesService],
})
export class AthletesModule {}
