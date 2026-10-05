import { describeChanges, selectRecentWtSlugs } from "./sources-sync";

describe("sources-sync — logique pure", () => {
  const NOW = new Date("2026-10-05T04:00:00.000Z");
  const ev = (slug: string, end: string) => ({ slug, dateEnd: new Date(`${end}T00:00:00.000Z`) });

  it("résultats WT : terminées depuis 30 jours seulement (ni en cours/aujourd'hui, ni trop anciennes)", () => {
    const items = [ev("hier", "2026-10-04"), ev("aujourdhui", "2026-10-05"), ev("il-y-a-30j", "2026-09-05"), ev("il-y-a-31j", "2026-09-04"), ev("futur", "2026-10-20")];
    expect(selectRecentWtSlugs(items, new Set(), new Set(), NOW)).toEqual(["hier", "il-y-a-30j"]);
  });

  it("jamais un événement déjà importé ni déjà présent dans un run de backfill (ex. #23 en pause ou en échec)", () => {
    const items = [ev("deja-importe", "2026-10-01"), ev("australian-open-2026", "2026-10-02"), ev("nouveau", "2026-10-03")];
    expect(selectRecentWtSlugs(items, new Set(["deja-importe"]), new Set(["australian-open-2026"]), NOW)).toEqual(["nouveau"]);
  });

  it("description lisible des changements (dates en français)", () => {
    expect(
      describeChanges([
        { field: "date_debut", before: "2027-03-13", after: "2027-03-20" },
        { field: "ville", before: "Eaubonne", after: "Cergy" },
      ]),
    ).toBe("date 13 mars 2027 → 20 mars 2027, ville Eaubonne → Cergy");
  });
});
