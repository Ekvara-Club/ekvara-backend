import { computeSkillScore } from "./skill-score";

describe("computeSkillScore", () => {
  it("capacité « higher » : interpolation linéaire, arrondie", () => {
    expect(computeSkillScore(85, 40, 140)).toBe(45);
    expect(computeSkillScore(72, 0, 100)).toBe(72);
  });

  it("capacité « lower » (temps de réaction) : plus bas = meilleure note", () => {
    expect(computeSkillScore(380, 600, 250)).toBe(63);
    expect(computeSkillScore(420, 600, 250)).toBe(51);
  });

  it("bornée à 0..100 hors barème", () => {
    expect(computeSkillScore(200, 600, 250)).toBe(100);
    expect(computeSkillScore(700, 600, 250)).toBe(0);
  });

  it("valeur ou barème manquant, ou barème dégénéré : null (jamais une note inventée)", () => {
    expect(computeSkillScore(null, 0, 100)).toBeNull();
    expect(computeSkillScore(50, null, 100)).toBeNull();
    expect(computeSkillScore(50, 10, 10)).toBeNull();
  });
});
