import { CanActivate, Injectable, NotFoundException } from "@nestjs/common";

// Les imports de catalogue (FFTDA, World Taekwondo, Martial Events)
// interrogent des sites externes et écrivent en base : jamais déclenchables
// par n'importe qui sur Internet. Fermés par défaut (404, la route n'est même
// pas révélée) ; ALLOW_HTTP_IMPORTS=true les rouvre en développement
// (Postman). En production, utiliser la CLI : npm run import:competitions.
// NODE_ENV=production les ferme TOUJOURS, même si le drapeau a été recopié
// par erreur depuis un .env de développement.
@Injectable()
export class HttpImportsGuard implements CanActivate {
  canActivate(): boolean {
    if (process.env.NODE_ENV === "production" || process.env.ALLOW_HTTP_IMPORTS !== "true") {
      throw new NotFoundException();
    }
    return true;
  }
}
