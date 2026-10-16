import { detectDuplicateCompetitions, DuplicateInput, ExistingCompetition } from "./admin-competition-duplicates";
import { competitionOrigin, EDITABLE_FIELDS, MANUAL_SOURCE } from "./admin-competition-origin";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function existing(id: string, nom: string, dateDebut: string, extra: Partial<ExistingCompetition> = {}): ExistingCompetition {
  return {
    id,
    nom,
    date_debut: day(dateDebut),
    date_fin: null,
    lieu: null,
    ville: null,
    pays: null,
    organisateur: null,
    niveau: null,
    sources: [{ source: "fftda" }],
    ...extra,
  };
}

function input(nom: string, dateDebut: string, extra: Partial<DuplicateInput> = {}): DuplicateInput {
  return { nom, dateDebut: day(dateDebut), dateFin: null, lieu: null, ville: null, pays: null, organisateur: null, niveau: null, ...extra };
}

describe("detectDuplicateCompetitions (règle matchCompetitions réutilisée)", () => {
  it("même date + catégorie d'âge partagée (SAFE de la règle) -> probable", () => {
    const [candidate] = detectDuplicateCompetitions(input("Championnat de France Cadets", "2026-03-14"), [
      existing("a", "Chpt France Cadets", "2026-03-14"),
    ]);
    expect(candidate).toMatchObject({ id: "a", level: "probable", dayGap: 0 });
    expect(candidate.reasons[0]).toBe("date de début identique");
  });

  it("même date + seul signal faible (AMBIGUOUS de la règle) -> possible, jamais probable", () => {
    const [candidate] = detectDuplicateCompetitions(input("Open de Poissy", "2026-02-07", { ville: "Poissy" }), [
      existing("a", "Open Labellisé de Poissy", "2026-02-07", { ville: "Poissy" }),
    ]);
    expect(candidate.level).toBe("possible");
  });

  it("nom identique (casse/accents ignorés) et même date -> probable", () => {
    const [candidate] = detectDuplicateCompetitions(input("open d'ÉAUBONNE 2026", "2026-05-02"), [
      existing("a", "Open d'Eaubonne 2026", "2026-05-02"),
    ]);
    expect(candidate).toMatchObject({ level: "probable" });
    expect(candidate.reasons).toContain("nom identique");
  });

  it("date de début proche (± 7 jours) avec signal de nom -> possible, écart indiqué", () => {
    const [candidate] = detectDuplicateCompetitions(input("Coupe de France Juniors", "2026-04-10"), [
      existing("a", "Cpe France Juniors", "2026-04-12"),
    ]);
    expect(candidate).toMatchObject({ level: "possible", dayGap: 2 });
    expect(candidate.reasons[0]).toBe("date de début à 2 jour(s) d'écart");
    expect(candidate.reasons).not.toContain("date de début identique");
  });

  it("au-delà de 7 jours, ou sans aucun signal commun -> aucune correspondance", () => {
    expect(
      detectDuplicateCompetitions(input("Coupe de France Juniors", "2026-04-10"), [existing("a", "Cpe France Juniors", "2026-04-18")]),
    ).toEqual([]);
    expect(
      detectDuplicateCompetitions(input("Open de Lyon", "2026-04-10", { ville: "Lyon" }), [
        existing("b", "International Training Camp", "2026-04-10", { ville: "Poissy" }),
      ]),
    ).toEqual([]);
  });

  describe("compétition strictement identique (A1)", () => {
    const known = existing("a", "Open Manuel d'Eaubonne", "2026-11-21", { date_fin: day("2026-11-22"), ville: "Eaubonne", pays: "France" });
    const same = { dateFin: day("2026-11-22"), ville: "Eaubonne", pays: "France" };

    it("nom (casse/accents/ponctuation ignorés), dates, ville et pays identiques -> exact (bloquant)", () => {
      const [candidate] = detectDuplicateCompetitions(input("OPEN MANUEL D EAUBONNE", "2026-11-21", same), [known]);
      expect(candidate).toMatchObject({ level: "probable", exact: true });
      expect(candidate.reasons.join(" ")).toContain("strictement identique");
    });

    it("champs descriptifs différents (lieu, organisateur, niveau) -> toujours exact", () => {
      const [candidate] = detectDuplicateCompetitions(
        input("Open Manuel d'Eaubonne", "2026-11-21", { ...same, lieu: "Gymnase", organisateur: "Club", niveau: "Open" }),
        [known],
      );
      expect(candidate.exact).toBe(true);
    });

    it("même nom mais autre date de fin, autre ville, autre pays ou date de fin inconnue -> confirmation, jamais bloquant", () => {
      for (const extra of [{ dateFin: day("2026-11-23") }, { ville: "Paris" }, { pays: "Belgique" }, { dateFin: null }]) {
        const [candidate] = detectDuplicateCompetitions(input("Open Manuel d'Eaubonne", "2026-11-21", { ...same, ...extra }), [known]);
        expect(candidate).toMatchObject({ level: "probable", exact: false });
      }
    });

    it("date de début proche ou nom seulement proche -> jamais bloquant", () => {
      expect(detectDuplicateCompetitions(input("Open Manuel d'Eaubonne", "2026-11-20", same), [known])[0]).toMatchObject({ exact: false });
      expect(detectDuplicateCompetitions(input("Open d'Eaubonne", "2026-11-21", same), [known])[0]?.exact ?? false).toBe(false);
    });
  });

  it("tri : probables d'abord, puis par écart de date croissant", () => {
    const candidates = detectDuplicateCompetitions(input("Championnat de France Seniors", "2026-06-10"), [
      existing("far", "Chpt France Seniors", "2026-06-15"),
      existing("near", "Chpt France Seniors", "2026-06-11"),
      existing("same", "Chpt France Seniors", "2026-06-10"),
    ]);
    expect(candidates.map((c) => c.id)).toEqual(["same", "near", "far"]);
  });
});

describe("competitionOrigin / EDITABLE_FIELDS (décision D4)", () => {
  it("manuelle seulement si TOUTES les sources sont ekvara_manual", () => {
    expect(competitionOrigin([{ source: MANUAL_SOURCE }])).toBe("manual");
    expect(competitionOrigin([{ source: MANUAL_SOURCE }, { source: "fftda" }])).toBe("imported");
    expect(competitionOrigin([{ source: "world_taekwondo" }])).toBe("imported");
    expect(competitionOrigin([])).toBe("imported");
  });

  it("compétition importée : seule la saison est modifiable", () => {
    expect(EDITABLE_FIELDS.imported).toEqual(["saison"]);
    expect(EDITABLE_FIELDS.manual).toContain("nom");
  });
});
