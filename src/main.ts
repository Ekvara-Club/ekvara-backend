import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(cookieParser());

  // Deux frontends de dev distincts partagent ce backend : EkvaraFrontend
  // (athlète, 5173) et EkvaraCoachFrontend (coach, 5174) — les deux origines
  // doivent fonctionner simultanément, jamais l'une au lieu de l'autre.
  app.enableCors({
    origin: ["http://localhost:5173", "http://localhost:5174"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // X-Ekvara-App : sélectionne la session (cookie) de l'application
    // appelante — voir auth.cookie.ts.
    allowedHeaders: ["Content-Type", "X-Ekvara-App"],
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap().catch((error) => {
  // Ex. JWT_SECRET absent (voir AuthGuardsModule) : échec propre plutôt
  // qu'un démarrage silencieux avec un secret de repli.
  // eslint-disable-next-line no-console
  console.error(`Échec du démarrage : ${(error as Error).message}`);
  process.exit(1);
});
