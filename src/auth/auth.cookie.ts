import { BadRequestException } from "@nestjs/common";
import type { CookieOptions, Request } from "express";

// Une session par APPLICATION, pas une session par navigateur : EkvaraFrontend
// (athlète, :5173) et EkvaraCoachFrontend (coach, :5174) tournent sur le même
// hôte, et les cookies ne sont pas isolés par port. Avec un cookie unique, le
// login d'une app réécrivait la session de l'autre (un compte différent, ou un
// compte sans le bon profil) et l'app restée ouverte finissait en 403. Chaque
// app a donc son propre cookie HttpOnly.
export const APP_CONTEXTS = ["athlete", "coach"] as const;
export type AppContext = (typeof APP_CONTEXTS)[number];

export const AUTH_COOKIE_NAMES: Record<AppContext, string> = {
  athlete: "ekvara_athlete_token",
  coach: "ekvara_coach_token",
};

// Ancien cookie partagé : n'authentifie plus personne (le relire referait le
// mélange de sessions). Seulement effacé au logout pour nettoyer les navigateurs
// qui le possèdent encore.
export const LEGACY_AUTH_COOKIE_NAME = "ekvara_auth_token";

// L'en-tête SÉLECTIONNE le cookie à lire/écrire, rien d'autre : il n'accorde
// aucun droit. L'autorisation reste portée par le payload du JWT vérifié
// (athleteId/coachId) et par les guards (CoachGuard, AthleteOwnershipGuard...).
export const APP_CONTEXT_HEADER = "x-ekvara-app";

// En-tête absent -> athlete : rétro-compatibilité pour les clients qui ne
// l'envoient pas (scripts, tests). Une valeur PRÉSENTE mais inconnue est en
// revanche refusée (400), jamais repliée silencieusement sur un contexte.
export const DEFAULT_APP_CONTEXT: AppContext = "athlete";

export function resolveAppContext(
  request: Pick<Request, "headers">,
): AppContext {
  const raw = request.headers[APP_CONTEXT_HEADER];
  if (raw === undefined) {
    return DEFAULT_APP_CONTEXT;
  }
  if (
    typeof raw === "string" &&
    (APP_CONTEXTS as readonly string[]).includes(raw)
  ) {
    return raw as AppContext;
  }
  throw new BadRequestException(
    `En-tête X-Ekvara-App invalide (attendu : ${APP_CONTEXTS.join(" | ")})`,
  );
}

export function authCookieNameFor(context: AppContext): string {
  return AUTH_COOKIE_NAMES[context];
}

// Attributs centralisés : register, login et logout doivent tous utiliser
// exactement les mêmes (sinon clearCookie ne cible pas le bon cookie).
function baseCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

export function buildAuthCookieOptions(maxAgeMs: number): CookieOptions {
  return {
    ...baseCookieOptions(),
    maxAge: maxAgeMs > 0 ? maxAgeMs : undefined,
  };
}

export function buildLogoutCookieOptions(): CookieOptions {
  return baseCookieOptions();
}
