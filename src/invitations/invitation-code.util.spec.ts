import {
  generateInvitationCode,
  hashInvitationCode,
  normalizeInvitationCode,
} from "./invitation-code.util";

describe("invitation-code.util", () => {
  describe("generateInvitationCode", () => {
    it("produit le format EKV-XXXXXXXX (8 caractères après le préfixe)", () => {
      const code = generateInvitationCode();
      expect(code).toMatch(/^EKV-[A-Z0-9]{8}$/);
    });

    it("n'utilise jamais les caractères ambigus 0/O/1/I", () => {
      for (let i = 0; i < 200; i += 1) {
        const code = generateInvitationCode();
        expect(code).not.toMatch(/[01IO]/);
      }
    });

    it("génère des codes différents à chaque appel (entropie réelle, jamais une valeur fixe)", () => {
      const codes = new Set(Array.from({ length: 50 }, () => generateInvitationCode()));
      expect(codes.size).toBe(50);
    });
  });

  describe("normalizeInvitationCode", () => {
    const CANONICAL = "K7M4PQ8R";

    it.each([
      ["EKV-K7M4PQ8R", CANONICAL],
      ["ekv-k7m4pq8r", CANONICAL],
      ["EKVK7M4PQ8R", CANONICAL],
      ["  EKV-K7M4PQ8R  ", CANONICAL],
      ["K7M4PQ8R", CANONICAL],
    ])("normalise %s -> %s", (input, expected) => {
      expect(normalizeInvitationCode(input)).toBe(expected);
    });
  });

  describe("hashInvitationCode", () => {
    it("est déterministe pour la même entrée normalisée", () => {
      expect(hashInvitationCode("K7M4PQ8R")).toBe(hashInvitationCode("K7M4PQ8R"));
    });

    it("ne renvoie jamais le code en clair", () => {
      const hash = hashInvitationCode("K7M4PQ8R");
      expect(hash).not.toContain("K7M4PQ8R");
      expect(hash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });

    it("produit des hash différents pour des codes différents", () => {
      expect(hashInvitationCode("K7M4PQ8R")).not.toBe(hashInvitationCode("K7M4PQ8S"));
    });
  });
});
