import { DEV_CORS_ORIGINS, resolveCorsOrigins, resolveTrustProxy } from "./runtime-config";

describe("runtime-config", () => {
  describe("resolveCorsOrigins", () => {
    it("dev sans variable : les deux frontends Vite locaux", () => {
      expect(resolveCorsOrigins({})).toEqual(DEV_CORS_ORIGINS);
    });

    it("production sans variable : refus de démarrer (jamais un repli silencieux sur localhost)", () => {
      expect(() => resolveCorsOrigins({ NODE_ENV: "production" })).toThrow(/CORS_ORIGINS est obligatoire/);
    });

    it("liste séparée par des virgules, espaces et / final retirés", () => {
      expect(resolveCorsOrigins({ CORS_ORIGINS: " https://app.ekvara.fr/ , https://coach.ekvara.fr " })).toEqual([
        "https://app.ekvara.fr",
        "https://coach.ekvara.fr",
      ]);
    });

    it("origine avec chemin ou sans schéma : refusée", () => {
      expect(() => resolveCorsOrigins({ CORS_ORIGINS: "https://app.ekvara.fr/login" })).toThrow(/invalide/);
      expect(() => resolveCorsOrigins({ CORS_ORIGINS: "app.ekvara.fr" })).toThrow(/invalide/);
    });
  });

  describe("resolveTrustProxy", () => {
    it("absent : pas de proxy ; sinon booléen, nombre de sauts ou valeur Express telle quelle", () => {
      expect(resolveTrustProxy({})).toBeUndefined();
      expect(resolveTrustProxy({ TRUST_PROXY: "true" })).toBe(true);
      expect(resolveTrustProxy({ TRUST_PROXY: "2" })).toBe(2);
      expect(resolveTrustProxy({ TRUST_PROXY: "loopback" })).toBe("loopback");
    });
  });
});
