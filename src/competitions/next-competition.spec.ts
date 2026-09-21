import { isActivePreparationStatus, selectNextCompetition, todayUtcMidnight } from "./next-competition";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const participation = (competitionId: string, start: string) => ({ competitionId, startDate: d(start), value: { kind: "p", competitionId } });
const preparation = (competitionId: string, start: string, status = "pret") => ({
  competitionId,
  startDate: d(start),
  status,
  value: { kind: "r", competitionId, status },
});

function select(input: {
  participations?: ReturnType<typeof participation>[];
  preparations?: ReturnType<typeof preparation>[];
  withParticipation?: string[];
}) {
  return selectNextCompetition({
    activeParticipations: input.participations ?? [],
    preparations: input.preparations ?? [],
    competitionIdsWithParticipation: new Set(input.withParticipation ?? []),
  });
}

describe("selectNextCompetition — règle unique Athlete / Coach", () => {
  it("rien -> null", () => {
    expect(select({})).toBeNull();
  });

  it("participation seule -> participation, sans préparation", () => {
    const result = select({ participations: [participation("a", "2026-10-10")] });

    expect(result).toEqual({ source: "participation", participation: { kind: "p", competitionId: "a" }, preparation: null });
  });

  it("préparation seule -> coach_preparation", () => {
    const result = select({ preparations: [preparation("a", "2027-03-13")] });

    expect(result).toMatchObject({ source: "coach_preparation", preparation: { competitionId: "a" } });
  });

  it("plusieurs compétitions -> la plus proche (10 oct. 2026 avant 13 mars 2027 avant 20 avr. 2027), quel que soit l'ordre d'entrée", () => {
    const preparations = [preparation("apr", "2027-04-20"), preparation("oct", "2026-10-10"), preparation("mar", "2027-03-13")];

    expect(select({ preparations })).toMatchObject({ preparation: { competitionId: "oct" } });
    expect(select({ preparations: [...preparations].reverse() })).toMatchObject({ preparation: { competitionId: "oct" } });
  });

  it("mélange participation / préparation : la plus proche l'emporte, dans les deux sens", () => {
    expect(
      select({ participations: [participation("far", "2027-03-13")], preparations: [preparation("near", "2026-10-10")] }),
    ).toMatchObject({ source: "coach_preparation", preparation: { competitionId: "near" } });

    expect(
      select({ participations: [participation("near", "2026-10-10")], preparations: [preparation("far", "2027-03-13")] }),
    ).toMatchObject({ source: "participation", participation: { competitionId: "near" } });
  });

  it("même compétition en participation ET préparation -> UNE seule, la participation, enrichie de la préparation", () => {
    const result = select({
      participations: [participation("x", "2027-03-13")],
      preparations: [preparation("x", "2027-03-13", "selectionne")],
    });

    expect(result).toEqual({
      source: "participation",
      participation: { kind: "p", competitionId: "x" },
      preparation: { kind: "r", competitionId: "x", status: "selectionne" },
    });
  });

  it("à date égale entre deux compétitions différentes, la participation prime", () => {
    const result = select({
      participations: [participation("p", "2026-10-10")],
      preparations: [preparation("r", "2026-10-10")],
    });

    expect(result).toMatchObject({ source: "participation", participation: { competitionId: "p" } });
  });

  it("forfait : jamais 'prochaine compétition', on retient la suivante active", () => {
    const only = select({ preparations: [preparation("f", "2026-10-10", "forfait")] });
    const next = select({
      preparations: [preparation("f", "2026-10-10", "forfait"), preparation("ok", "2027-03-13", "pret")],
    });

    expect(only).toBeNull();
    expect(next).toMatchObject({ preparation: { competitionId: "ok" } });
  });

  it("préparation forfait sur une compétition avec participation active : participation retenue, SANS enrichissement forfait", () => {
    const result = select({
      participations: [participation("x", "2027-03-13")],
      preparations: [preparation("x", "2027-03-13", "forfait")],
    });

    expect(result).toEqual({ source: "participation", participation: { kind: "p", competitionId: "x" }, preparation: null });
  });

  it("compétition dont la participation existe mais est inactive (annulée/retirée) : la préparation n'est pas présentée seule", () => {
    const result = select({ preparations: [preparation("x", "2027-03-13")], withParticipation: ["x"] });

    expect(result).toBeNull();
  });

  it("statut de préparation inconnu : traité comme actif (seul 'forfait' exclut)", () => {
    expect(select({ preparations: [preparation("a", "2026-10-10", "autre")] })).not.toBeNull();
  });
});

describe("isActivePreparationStatus", () => {
  it("seul 'forfait' n'est pas actif", () => {
    expect(isActivePreparationStatus("forfait")).toBe(false);
    for (const status of ["envisage", "selectionne", "pret"]) {
      expect(isActivePreparationStatus(status)).toBe(true);
    }
  });
});

describe("todayUtcMidnight", () => {
  it("minuit UTC du jour courant : une compétition d'aujourd'hui (DATE) reste éligible", () => {
    expect(todayUtcMidnight(new Date("2026-09-21T15:42:10.000Z"))).toEqual(new Date("2026-09-21T00:00:00.000Z"));
  });
});
