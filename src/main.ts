import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import { resolveCorsOrigins, resolveTrustProxy } from "./config/runtime-config";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Derrière Caddy + Cloudflare Tunnel en production (voir deploy/) : req.ip
  // doit être l'adresse du vrai client, pas celle du proxy.
  const trustProxy = resolveTrustProxy();
  if (trustProxy !== undefined) {
    app.set("trust proxy", trustProxy);
  }

  app.use(cookieParser());

  // Deux frontends distincts partagent ce backend : EkvaraFrontend (athlète)
  // et EkvaraCoachFrontend (coach) — les deux origines doivent fonctionner
  // simultanément. Dev : localhost:5173/5174 ; production : CORS_ORIGINS.
  app.enableCors({
    origin: resolveCorsOrigins(),
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
