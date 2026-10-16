import { athleteOrigin, detectDuplicateAthletes, EDITABLE_ATHLETE_FIELDS, ExistingAthlete, nameTokens } from "./admin-athlete-rules";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function existing(id: string, display_name: string, extra: Partial<ExistingAthlete> = {}): ExistingAthlete {
  return { id, display_name, country_code: null, birth_date: null, sources: [{ source: "world_taekwondo_results" }], ...extra };
}

describe("nameTokens", () => {
  it("ignore casse, accents, ponctuation et ordre des mots", () => {
    expect(nameTokens("KIM Min-su")).toEqual(nameTokens("min su  Kim"));
    expect(nameTokens("López, Iñaki")).toEqual(["inaki", "lopez"]);
  });
});

describe("detectDuplicateAthletes (jamais de fusion, signalement seulement)", () => {
  const input = (displayName: string, countryCode: string | null = null, birthDate: Date | null = null) => ({ displayName, countryCode, birthDate });

  it("même nom, ordre inversé (format WT « NOM Prénom ») -> probable", () => {
    const [candidate] = detectDuplicateAthletes(input("Minsu Kim"), [existing("a", "KIM Minsu")]);
    expect(candidate).toMatchObject({ id: "a", level: "probable", sources: ["world_taekwondo_results"] });
    expect(candidate.reasons[0]).toMatch(/nom identique/);
  });

  it("même nom et même pays -> probable, raison indiquée", () => {
    const [candidate] = detectDuplicateAthletes(input("Kim Minsu", "KOR"), [existing("a", "KIM Minsu", { country_code: "KOR" })]);
    expect(candidate.level).toBe("probable");
    expect(candidate.reasons).toContain("même pays (KOR)");
  });

  it("même nom mais pays différent -> possible (homonyme plausible)", () => {
    const [candidate] = detectDuplicateAthletes(input("Kim Minsu", "FRA"), [existing("a", "KIM Minsu", { country_code: "KOR" })]);
    expect(candidate.level).toBe("possible");
    expect(candidate.reasons).toContain("pays différent (FRA / KOR)");
  });

  it("même nom mais date de naissance différente -> possible", () => {
    const [candidate] = detectDuplicateAthletes(input("Kim Minsu", null, day("2001-03-04")), [
      existing("a", "KIM Minsu", { birth_date: day("1999-03-04") }),
    ]);
    expect(candidate.level).toBe("possible");
    expect(candidate.reasons).toContain("date de naissance différente");
  });

  it("nom contenu dans l'autre (deuxième prénom) -> possible ; un seul mot commun -> ignoré", () => {
    expect(detectDuplicateAthletes(input("Kim Minsu"), [existing("a", "KIM Minsu Jae")])).toEqual([
      expect.objectContaining({ id: "a", level: "possible" }),
    ]);
    expect(detectDuplicateAthletes(input("Kim Minsu"), [existing("b", "KIM Jiwoo")])).toEqual([]);
  });

  it("tri : probables d'abord", () => {
    const candidates = detectDuplicateAthletes(input("Kim Minsu"), [existing("p2", "KIM Minsu Jae"), existing("p1", "Minsu KIM")]);
    expect(candidates.map((c) => c.id)).toEqual(["p1", "p2"]);
  });
});

describe("athleteOrigin / EDITABLE_ATHLETE_FIELDS", () => {
  it("manuel seulement si toutes les sources sont ekvara_manual", () => {
    expect(athleteOrigin([{ source: "ekvara_manual" }])).toBe("manual");
    expect(athleteOrigin([{ source: "ekvara_manual" }, { source: "world_taekwondo_results" }])).toBe("imported");
    expect(athleteOrigin([])).toBe("imported");
  });

  it("importé : nom et pays jamais modifiables, genre et date de naissance oui", () => {
    expect(EDITABLE_ATHLETE_FIELDS.imported).toEqual(["gender", "birthDate"]);
    expect(EDITABLE_ATHLETE_FIELDS.manual).toEqual(["displayName", "countryCode", "gender", "birthDate"]);
  });
});
