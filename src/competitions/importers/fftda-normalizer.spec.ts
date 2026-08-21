import { isCompetition, normalizeFftdaItem, FftdaCalendarItem } from "./fftda-normalizer";

function item(overrides: Partial<FftdaCalendarItem> & Pick<FftdaCalendarItem, "_id" | "name" | "start">): FftdaCalendarItem {
  return { ...overrides };
}

describe("isCompetition", () => {
  it.each([
    ["Championnat de France Juniors", 509],
    ["Chpt. de France Universitaire", 449],
    ["Val de Reuil Cup International (B/M/C/J)", 477],
    ["Open Labellisé de Poissy", 451],
    ["World Taekwondo Grand Prix", 497],
  ])("accepte une vraie compétition: %s", (name, _id) => {
    expect(isCompetition(item({ _id, name, start: "2026-01-01T00:00:00+01:00" }))).toBe(true);
  });

  it.each([
    ["Formation arbitre", 900],
    ["Conseil des Présidents", 901],
    ["Séminaire national d'arbitrage", 902],
    ["Passage de grade", 903],
    ["Assemblée Générale", 904],
    ["Réunion du bureau", 905],
    ["Examen national Dan", 906],
  ])("rejette un événement non compétitif: %s", (name, _id) => {
    expect(isCompetition(item({ _id, name, start: "2026-01-01T00:00:00+01:00" }))).toBe(false);
  });

  it("n'exclut pas une vraie compétition dont le contenu mentionne 'informations' (sous-chaîne de 'formation')", () => {
    const realCompetition = item({
      _id: 449,
      name: "Chpt. de France Universitaire",
      start: "2026-01-16T00:00:00+01:00",
      end: "2026-01-17T00:00:00+01:00",
      content:
        "<p>📌<strong>&nbsp;informations essentielles</strong></p><p>Lieu : Centre Sportif de l'Arténium 4 parc de l'Artière 63122 CEYRAT</p>",
    });

    expect(isCompetition(realCompetition)).toBe(true);
  });

  it("n'exclut pas une vraie compétition dont le contenu mentionne une réunion annexe (ex: briefing zoom)", () => {
    const realCompetition = item({
      _id: 452,
      name: "Chpt. Fra. senior (combat) / Chpt. Fra Poomsae",
      start: "2026-02-21T00:00:00+01:00",
      end: "2026-02-22T00:00:00+01:00",
      content:
        "<ul><li>Merci de participer à la réunion zoom de préparation</li><li>Lieu : Centre Sportif Athletica</li></ul>",
    });

    expect(isCompetition(realCompetition)).toBe(true);
  });
});

describe("normalizeFftdaItem", () => {
  it("source vaut toujours 'fftda'", () => {
    const result = normalizeFftdaItem(
      item({ _id: 509, name: "Championnat de France Juniors", start: "2027-05-09T00:00:00+02:00" }),
    );
    expect(result?.source).toBe("fftda");
  });

  it("génère un sourceExternalId stable à partir de l'_id FFTDA", () => {
    const result = normalizeFftdaItem(
      item({ _id: 509, name: "Championnat de France Juniors", start: "2027-05-09T00:00:00+02:00" }),
    );
    expect(result?.sourceExternalId).toBe("509");

    const resultAgain = normalizeFftdaItem(
      item({ _id: 509, name: "Championnat de France Juniors", start: "2027-05-09T00:00:00+02:00" }),
    );
    expect(resultAgain?.sourceExternalId).toBe(result?.sourceExternalId);
  });

  it("normalise une compétition sur un seul jour sans dateFin", () => {
    const result = normalizeFftdaItem(
      item({
        _id: 509,
        name: "Championnat de France Juniors",
        start: "2027-05-09T00:00:00+02:00",
        end: "2027-05-09T00:00:00+02:00",
        address: { text: "Aréna Béthune-Bruay, Rue des Déportés, 62131 Verquin, France" },
      }),
    );

    expect(result?.dateDebut).toEqual(new Date(Date.UTC(2027, 4, 9)));
    expect(result?.dateFin).toBeUndefined();
    expect(result?.ville).toBe("Verquin");
    expect(result?.pays).toBe("France");
  });

  it("normalise une compétition sur plusieurs jours avec dateDebut et dateFin distinctes", () => {
    const result = normalizeFftdaItem(
      item({
        _id: 451,
        name: "Open Labellisé de Poissy",
        start: "2026-02-07T00:00:00+01:00",
        end: "2026-02-08T00:00:00+01:00",
        address: { text: "129 Avenue de la Maladrerie, 78300 Poissy, France" },
      }),
    );

    expect(result?.dateDebut).toEqual(new Date(Date.UTC(2026, 1, 7)));
    expect(result?.dateFin).toEqual(new Date(Date.UTC(2026, 1, 8)));
    expect(result?.ville).toBe("Poissy");
  });

  it("rejette (retourne null) une date de début invalide plutôt que de deviner", () => {
    const result = normalizeFftdaItem(
      item({ _id: 999, name: "Championnat de France Test", start: "date-invalide" }),
    );
    expect(result).toBeNull();
  });

  it("laisse ville et pays undefined quand l'adresse est absente, sans deviner", () => {
    const result = normalizeFftdaItem(
      item({ _id: 497, name: "World Taekwondo Grand Prix", start: "2026-10-08T00:00:00+02:00" }),
    );
    expect(result?.ville).toBeUndefined();
    expect(result?.pays).toBeUndefined();
  });
});
