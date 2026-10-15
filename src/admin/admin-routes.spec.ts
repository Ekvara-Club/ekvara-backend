import { GUARDS_METADATA, METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminGuard } from "./admin.guard";
import { deriveAdminJwtSecret, resolveAdminUserIds } from "./admin-config";
import { TEST_JWT_SECRET } from "../test-utils/auth-test.helper";

// AdminModule importe CompetitionsModule -> AuthGuardsModule, qui exige
// JWT_SECRET dès son chargement : secret de test fixé AVANT le require (les
// import sont remontés en tête de fichier, d'où le require explicite).
process.env.JWT_SECRET ??= TEST_JWT_SECRET;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AdminModule } = require("./admin.module") as typeof import("./admin.module");

// Filet structurel (ticket §13 : autorisation vérifiée sur CHAQUE endpoint
// d'administration) : tout contrôleur enregistré dans AdminModule — y compris
// ceux des phases suivantes — doit porter AdminGuard sur chacune de ses
// routes. Seule exception explicite : la connexion elle-même.
const ROUTES_WITHOUT_ADMIN_GUARD = new Set([`${AdminAuthController.name}.login`]);

describe("AdminModule : chaque route est protégée par AdminGuard", () => {
  const controllers: Function[] = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AdminModule) ?? [];

  it("le module déclare au moins un contrôleur", () => {
    expect(controllers.length).toBeGreaterThan(0);
  });

  for (const controller of controllers) {
    const prototype = controller.prototype as Record<string, unknown>;
    const handlers = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== "constructor" && Reflect.getMetadata(METHOD_METADATA, prototype[name] as object) !== undefined,
    );

    for (const handler of handlers) {
      const id = `${controller.name}.${handler}`;
      it(`${id} (${Reflect.getMetadata(PATH_METADATA, prototype[handler] as object)})`, () => {
        const guards: unknown[] = [
          ...(Reflect.getMetadata(GUARDS_METADATA, controller) ?? []),
          ...(Reflect.getMetadata(GUARDS_METADATA, prototype[handler] as object) ?? []),
        ];
        if (ROUTES_WITHOUT_ADMIN_GUARD.has(id)) {
          expect(guards).not.toContain(AdminGuard);
        } else {
          expect(guards).toContain(AdminGuard);
        }
      });
    }
  }
});

describe("resolveAdminUserIds", () => {
  const ID = "0b6f3c1e-2a4d-4e5f-9a7b-1c2d3e4f5a6b";

  it("absente ou vide -> aucun administrateur (fermé par défaut)", () => {
    expect(resolveAdminUserIds({}).size).toBe(0);
    expect(resolveAdminUserIds({ ADMIN_USER_IDS: "  " }).size).toBe(0);
  });

  it("liste séparée par des virgules, espaces tolérés, casse normalisée", () => {
    const ids = resolveAdminUserIds({ ADMIN_USER_IDS: ` ${ID.toUpperCase()} , 7c8d9e0f-1a2b-4c3d-8e9f-0a1b2c3d4e5f,` });
    expect([...ids]).toEqual([ID, "7c8d9e0f-1a2b-4c3d-8e9f-0a1b2c3d4e5f"]);
  });

  it("valeur qui n'est pas un UUID -> erreur de démarrage, jamais ignorée", () => {
    expect(() => resolveAdminUserIds({ ADMIN_USER_IDS: `${ID},admin@ekvara.fr` })).toThrow(/ADMIN_USER_IDS invalide/);
  });
});

describe("deriveAdminJwtSecret", () => {
  it("déterministe, distinct du secret d'origine et dépendant de lui", () => {
    expect(deriveAdminJwtSecret("a")).toBe(deriveAdminJwtSecret("a"));
    expect(deriveAdminJwtSecret("a")).not.toBe("a");
    expect(deriveAdminJwtSecret("a")).not.toBe(deriveAdminJwtSecret("b"));
  });
});
