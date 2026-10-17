import type { CookieOptions } from "express";

// Session d'administration : volontairement indépendante des sessions Athlete
// et Coach (auth.cookie.ts reste inchangé — "admin" n'y est PAS un contexte
// X-Ekvara-App). Cookie propre, secret de signature dérivé (admin-config.ts),
// audience dédiée, durée courte.
export const ADMIN_COOKIE_NAME = "ekvara_admin_token";
export const ADMIN_TOKEN_AUDIENCE = "ekvara-admin";
export const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;

// Protection CSRF : jeton aléatoire généré à la connexion, inscrit dans le JWT
// (cookie HttpOnly, donc illisible et non falsifiable par une page tierce) et
// renvoyé au portail dans le corps de la réponse. Toute requête admin
// non-sûre doit le renvoyer dans cet en-tête ; le guard le compare au jeton
// signé (synchronizer token lié à la session, jamais un simple double-submit).
export const ADMIN_CSRF_HEADER = "x-ekvara-csrf";

export const ADMIN_SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export interface AdminJwtPayload {
  sub: string; // app_user.id
  sid: string; // admin_session.id : session relue en base à chaque requête
  csrf: string;
  exp?: number;
}

// Identité admin résolue par AdminGuard, attachée à la requête.
export interface AdminContext {
  userId: string;
  sessionId: string;
  csrfToken: string;
  expiresAt: Date;
}

// SameSite=Strict : le portail appelle l'API via son proxy local (même
// origine), le cookie n'a jamais besoin d'accompagner une navigation ou une
// requête intersite. Secure en production.
function baseAdminCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

export function buildAdminCookieOptions(): CookieOptions {
  return { ...baseAdminCookieOptions(), maxAge: ADMIN_SESSION_TTL_SECONDS * 1000 };
}

export function buildAdminLogoutCookieOptions(): CookieOptions {
  return baseAdminCookieOptions();
}
