import { IMPROVEMENT_DIRECTIONS, isImprovementDirection } from "./improvement-direction";

describe("isImprovementDirection", () => {
  it("accepte 'higher'", () => {
    expect(isImprovementDirection("higher")).toBe(true);
  });

  it("accepte 'lower'", () => {
    expect(isImprovementDirection("lower")).toBe(true);
  });

  it("null reste possible (direction pas encore connue, pas une erreur)", () => {
    expect(isImprovementDirection(null)).toBe(false);
  });

  it("n'accepte aucune valeur arbitraire", () => {
    expect(isImprovementDirection("up")).toBe(false);
    expect(isImprovementDirection("bigger")).toBe(false);
    expect(isImprovementDirection("")).toBe(false);
    expect(isImprovementDirection("HIGHER")).toBe(false);
    expect(isImprovementDirection(undefined)).toBe(false);
    expect(isImprovementDirection(42)).toBe(false);
  });

  it("IMPROVEMENT_DIRECTIONS ne contient que les deux valeurs prévues", () => {
    expect(IMPROVEMENT_DIRECTIONS).toEqual(["higher", "lower"]);
  });
});
