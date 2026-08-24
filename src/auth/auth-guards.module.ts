import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import type { SignOptions } from "jsonwebtoken";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { AthleteOwnershipGuard } from "./athlete-ownership.guard";
import { CoachGuard } from "./coach.guard";
import { CoachAthleteAccessGuard } from "./coach-athlete-access.guard";
import { CoachGroupOwnershipGuard } from "./coach-group-ownership.guard";
import { CoachTrainingOwnershipGuard } from "./coach-training-ownership.guard";
import { CoachExerciseOwnershipGuard } from "./coach-exercise-ownership.guard";

// Refuse de démarrer plutôt que d'utiliser un secret de repli dangereux.
// Exécuté au chargement du module (avant que Nest ne construise quoi que ce
// soit), donc le process échoue immédiatement si la variable est absente.
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error(
    "JWT_SECRET est requis (voir .env.example). Aucun secret de repli n'est utilisé.",
  );
}

// Module séparé de AuthModule pour éviter un cycle : AuthModule importe
// AthletesModule (réutilisation de AthletesService), et les modules métier
// (weights, goals, athletes...) ont besoin des guards sans dépendre de tout
// AuthModule. Racine du graphe, ne dépend de rien d'autre.
@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret,
      signOptions: {
        expiresIn: (process.env.JWT_EXPIRES_IN ?? "7d") as SignOptions["expiresIn"],
      },
    }),
  ],
  providers: [
    JwtAuthGuard,
    AthleteOwnershipGuard,
    CoachGuard,
    CoachAthleteAccessGuard,
    CoachGroupOwnershipGuard,
    CoachTrainingOwnershipGuard,
    CoachExerciseOwnershipGuard,
  ],
  exports: [
    JwtModule,
    JwtAuthGuard,
    AthleteOwnershipGuard,
    CoachGuard,
    CoachAthleteAccessGuard,
    CoachGroupOwnershipGuard,
    CoachTrainingOwnershipGuard,
    CoachExerciseOwnershipGuard,
  ],
})
export class AuthGuardsModule {}
