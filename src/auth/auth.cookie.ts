import type { CookieOptions } from "express";

// Nom et configuration du cookie d'auth centralisés ici : register, login et
// logout doivent tous utiliser exactement les mêmes attributs.
export const AUTH_COOKIE_NAME = "ekvara_auth_token";

function baseCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
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
