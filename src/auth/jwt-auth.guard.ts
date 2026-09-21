import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import { authCookieNameFor, resolveAppContext } from "./auth.cookie";
import { JwtPayload } from "./jwt-payload.interface";

const AUTH_REQUIRED_MESSAGE = "Authentification requise";

// Ne fait jamais confiance à un identifiant envoyé par le frontend : lit le
// JWT depuis le cookie HttpOnly de l'application appelante (X-Ekvara-App
// sélectionne le cookie, jamais un droit), vérifie signature + expiration,
// attache l'identité résolue à la requête. 401 = pas de session valide pour
// CETTE application ; 403 reste réservé aux guards d'autorisation en aval.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token: unknown = request.cookies?.[authCookieNameFor(resolveAppContext(request))];

    if (!token || typeof token !== "string") {
      throw new UnauthorizedException(AUTH_REQUIRED_MESSAGE);
    }

    try {
      request.user = this.jwtService.verify<JwtPayload>(token);
      return true;
    } catch {
      throw new UnauthorizedException(AUTH_REQUIRED_MESSAGE);
    }
  }
}
