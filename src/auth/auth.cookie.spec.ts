import { BadRequestException } from "@nestjs/common";
import {
  APP_CONTEXT_HEADER,
  AUTH_COOKIE_NAMES,
  DEFAULT_APP_CONTEXT,
  LEGACY_AUTH_COOKIE_NAME,
  authCookieNameFor,
  buildAuthCookieOptions,
  buildLogoutCookieOptions,
  resolveAppContext,
} from "./auth.cookie";

function req(headers: Record<string, string | string[] | undefined>) {
  return { headers };
}

describe("auth.cookie — contexte applicatif", () => {
  it("un cookie distinct par application, jamais le nom historique partagé", () => {
    expect(AUTH_COOKIE_NAMES.athlete).toBe("ekvara_athlete_token");
    expect(AUTH_COOKIE_NAMES.coach).toBe("ekvara_coach_token");
    expect(AUTH_COOKIE_NAMES.athlete).not.toBe(AUTH_COOKIE_NAMES.coach);
    expect(Object.values(AUTH_COOKIE_NAMES)).not.toContain(LEGACY_AUTH_COOKIE_NAME);
  });

  it("X-Ekvara-App: coach -> contexte coach ; athlete -> athlete", () => {
    expect(APP_CONTEXT_HEADER).toBe("x-ekvara-app");
    expect(resolveAppContext(req({ "x-ekvara-app": "coach" }))).toBe("coach");
    expect(resolveAppContext(req({ "x-ekvara-app": "athlete" }))).toBe("athlete");
  });

  it("en-tête absent -> contexte par défaut (athlete), documenté et rétro-compatible", () => {
    expect(DEFAULT_APP_CONTEXT).toBe("athlete");
    expect(resolveAppContext(req({}))).toBe("athlete");
  });

  it("valeur inconnue, vide, casse différente ou multiple -> 400 (jamais un repli silencieux)", () => {
    for (const value of ["admin", "", "COACH", "coach, athlete", ["coach", "athlete"]]) {
      expect(() => resolveAppContext(req({ "x-ekvara-app": value }))).toThrow(BadRequestException);
    }
  });

  it("authCookieNameFor retourne le nom du contexte", () => {
    expect(authCookieNameFor("coach")).toBe("ekvara_coach_token");
    expect(authCookieNameFor("athlete")).toBe("ekvara_athlete_token");
  });

  it("attributs du cookie : HttpOnly, SameSite=Lax, Path=/, sans Domain ; Max-Age aligné sur le JWT", () => {
    const options = buildAuthCookieOptions(3_600_000);
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 3_600_000 });
    expect(options.domain).toBeUndefined();
    expect(buildLogoutCookieOptions()).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });
});
