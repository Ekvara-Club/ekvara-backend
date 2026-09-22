import { parseScopeArgs } from "./wt-backfill-scope";

describe("parseScopeArgs (scope obligatoire, pur)", () => {
  it("--year=YYYY", () => {
    expect(parseScopeArgs(["--year=2026"])).toEqual({ kind: "year", year: 2026 });
  });

  it("--from/--to", () => {
    expect(parseScopeArgs(["--from=2026-01-01", "--to=2026-03-31"])).toEqual({ kind: "range", from: "2026-01-01", to: "2026-03-31" });
  });

  it("--slugs avec --years", () => {
    expect(parseScopeArgs(["--slugs=a,b", "--years=2026,2027"])).toEqual({ kind: "slugs", slugs: ["a", "b"], years: [2026, 2027] });
  });

  it("aucun scope -> REFUS (jamais de backfill total implicite)", () => {
    expect(() => parseScopeArgs([])).toThrow(/Scope obligatoire/);
  });

  it("--from sans --to -> refus", () => {
    expect(() => parseScopeArgs(["--from=2026-01-01"])).toThrow(/ensemble/);
  });

  it("--slugs sans --years -> refus", () => {
    expect(() => parseScopeArgs(["--slugs=a"])).toThrow(/--years/);
  });

  it("--year non entier -> refus", () => {
    expect(() => parseScopeArgs(["--year=abc"])).toThrow(/entier/);
  });
});
