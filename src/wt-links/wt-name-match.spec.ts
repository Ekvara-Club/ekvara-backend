import { namesMatch, nameTokens } from "./wt-name-match";

describe("wt-name-match", () => {
  it("insensible à la casse, aux accents, à l'ordre et aux séparateurs", () => {
    expect(nameTokens("Jean-Kaïs D'Almeida")).toEqual(["jean", "kais", "d", "almeida"]);
    expect(namesMatch("Kaïs Dilmi", "DILMI Kais")).toBe(true);
    expect(namesMatch("Kaïs Dilmi", "Kais Ahmed DILMI")).toBe(true);
  });

  it("un seul mot commun ne suffit jamais (homonymes de nom de famille)", () => {
    expect(namesMatch("Kaïs Dilmi", "Sofiane DILMI")).toBe(false);
    expect(namesMatch("Dilmi", "Kais DILMI")).toBe(false);
  });
});
