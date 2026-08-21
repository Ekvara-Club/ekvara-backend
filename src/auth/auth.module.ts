import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { AthletesModule } from "../athletes/athletes.module";
import { AuthGuardsModule } from "./auth-guards.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

const AUTH_THROTTLE_TTL_MS = 60_000;
const AUTH_THROTTLE_LIMIT = 8;

@Module({
  imports: [
    AthletesModule,
    AuthGuardsModule,
    // Appliqué uniquement via @UseGuards(ThrottlerGuard) sur register/login
    // (cf. AuthController) : le reste de l'API n'est pas throttled.
    ThrottlerModule.forRoot([{ ttl: AUTH_THROTTLE_TTL_MS, limit: AUTH_THROTTLE_LIMIT }]),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
