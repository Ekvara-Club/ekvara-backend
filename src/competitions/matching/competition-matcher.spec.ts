import { matchCompetitions } from "./competition-matcher";
import { ImportedCompetition } from "../importers/imported-competition.interface";

// Fixtures = données réelles observées le 21/08/2026 en croisant le
// calendrier FFTDA (https://www.fftda.fr/files/collection/53/fr.json) et les
// pages événement Martial.Events réellement fetchées (voir rapport du ticket
// précédent). Aucune dépendance réseau ici.

function competition(overrides: Partial<ImportedCompetition>): ImportedCompetition {
  return {
    source: "test",
    sourceExternalId: "0",
    nom: "Événement",
    dateDebut: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const fftdaSeniors = competition({
  source: "fftda",
  sourceExternalId: "455-seniors",
  nom: "Chpt. Fra. senior (combat) / Chpt. Fra Poomsae",
  dateDebut: new Date("2026-02-21T00:00:00Z"),
});

const meSeniors = competition({
  source: "martial_events",
  sourceExternalId: "1229",
  nom: "Championnat de France Seniors (Combat) 2026",
  dateDebut: new Date("2026-02-21T00:00:00Z"),
  ville: "Eaubonne",
  pays: "France",
});

const fftdaCadetJunior = competition({
  source: "fftda",
  sourceExternalId: "455",
  nom: "Cpe Fra. Benj. Min. /Chpt.Fra. Cadet Junior",
  dateDebut: new Date("2026-05-23T00:00:00Z"),
});

const meCadetJunior = competition({
  source: "martial_events",
  sourceExternalId: "1302",
  nom: "Championnat de France Cadet-Junior",
  dateDebut: new Date("2026-05-23T00:00:00Z"),
  ville: "Verquin",
  pays: "France",
});

const meRegionaleIdf = competition({
  source: "martial_events",
  sourceExternalId: "1243",
  nom: "Sélections Régionales IDF Combat - Championnat de France",
  dateDebut: new Date("2026-01-17T00:00:00Z"),
  ville: "Paris",
  pays: "France",
});

const meBordeaux = competition({
  source: "martial_events",
  sourceExternalId: "bordeaux",
  nom: "Open de Bordeaux Métropole",
  dateDebut: new Date("2026-09-19T00:00:00Z"),
  ville: "Pessac",
  pays: "France",
});

const meVilleneuve = competition({
  source: "martial_events",
  sourceExternalId: "villeneuve",
  nom: "9eme Open International de Villeneuve sur lot",
  dateDebut: new Date("2026-10-10T00:00:00Z"),
  ville: "Villeneuve-sur-Lot",
  pays: "France",
});

const fftdaPoissy = competition({
  source: "fftda",
  sourceExternalId: "451",
  nom: "Open Labellisé de Poissy",
  dateDebut: new Date("2026-02-07T00:00:00Z"),
  ville: "Poissy",
});

const mePoissy = competition({
  source: "martial_events",
  sourceExternalId: "poissy-camp",
  nom: "International Training Camp Poissy 2026",
  dateDebut: new Date("2026-10-28T00:00:00Z"),
  ville: "Poissy",
});

// Le calendrier FFTDA complet (77 entrées, audité pour ce ticket et le
// précédent) ne contient aucune entrée à ces dates — utilisé pour simuler
// "aucune correspondance trouvée" en comparant contre les mêmes fixtures
// nationales ci-dessus (dates différentes ⇒ DIFFERENT systématique).

describe("matchCompetitions — cas réels", () => {
  it("Seniors FFTDA ↔ Martial Events : SAFE (même date + catégorie d'âge + marqueur national partagés)", () => {
    const result = matchCompetitions(fftdaSeniors, meSeniors);
    expect(result.confidence).toBe("SAFE");
    expect(result.reasons.join(" ")).toMatch(/senior/);
  });

  it("Cadet-Junior FFTDA ↔ Martial Events : SAFE (noms très différents, même compétition réelle)", () => {
    const result = matchCompetitions(fftdaCadetJunior, meCadetJunior);
    expect(result.confidence).toBe("SAFE");
    expect(result.reasons.join(" ")).toMatch(/cadet|junior/);
  });

  it("Régionale IDF : aucune correspondance FFTDA (dates différentes ⇒ DIFFERENT)", () => {
    expect(matchCompetitions(meRegionaleIdf, fftdaSeniors).confidence).toBe("DIFFERENT");
    expect(matchCompetitions(meRegionaleIdf, fftdaCadetJunior).confidence).toBe("DIFFERENT");
    expect(matchCompetitions(meRegionaleIdf, fftdaPoissy).confidence).toBe("DIFFERENT");
  });

  it("Open Bordeaux : aucune correspondance FFTDA (dates différentes ⇒ DIFFERENT)", () => {
    expect(matchCompetitions(meBordeaux, fftdaSeniors).confidence).toBe("DIFFERENT");
    expect(matchCompetitions(meBordeaux, fftdaCadetJunior).confidence).toBe("DIFFERENT");
  });

  it("Open Villeneuve-sur-Lot : aucune correspondance FFTDA (dates différentes ⇒ DIFFERENT)", () => {
    expect(matchCompetitions(meVilleneuve, fftdaSeniors).confidence).toBe("DIFFERENT");
    expect(matchCompetitions(meVilleneuve, fftdaCadetJunior).confidence).toBe("DIFFERENT");
  });

  it("Poissy : faux positif géographique évité (même ville, dates réellement différentes ⇒ DIFFERENT, jamais SAFE)", () => {
    const result = matchCompetitions(fftdaPoissy, mePoissy);
    expect(result.confidence).toBe("DIFFERENT");
    expect(result.reasons.join(" ")).toMatch(/dates? de début différentes/);
  });
});

describe("matchCompetitions — cas synthétiques", () => {
  it("même ville mais date différente ⇒ DIFFERENT (jamais un signal suffisant)", () => {
    const a = competition({ nom: "Open de Nantes", dateDebut: new Date("2026-03-01T00:00:00Z"), ville: "Nantes" });
    const b = competition({ nom: "Coupe de Nantes", dateDebut: new Date("2026-06-15T00:00:00Z"), ville: "Nantes" });
    expect(matchCompetitions(a, b).confidence).toBe("DIFFERENT");
  });

  it("même date mais événement manifestement différent (aucun mot ni ville commun) ⇒ DIFFERENT", () => {
    const a = competition({ nom: "Open de Judo de Lille", dateDebut: new Date("2026-04-12T00:00:00Z"), ville: "Lille" });
    const b = competition({ nom: "Gala International de Karaté", dateDebut: new Date("2026-04-12T00:00:00Z"), ville: "Marseille" });
    expect(matchCompetitions(a, b).confidence).toBe("DIFFERENT");
  });

  it("même date + même ville seulement (aucun autre signal) ⇒ AMBIGUOUS, jamais SAFE", () => {
    const a = competition({ nom: "Gala Sportif Annuel", dateDebut: new Date("2026-05-01T00:00:00Z"), ville: "Reims" });
    const b = competition({ nom: "Compétition Régionale de Printemps", dateDebut: new Date("2026-05-01T00:00:00Z"), ville: "Reims" });
    const result = matchCompetitions(a, b);
    expect(result.confidence).toBe("AMBIGUOUS");
    expect(result.reasons.join(" ")).toMatch(/même ville/);
  });

  it("même date + mot significatif partagé mais sans marqueur national ni catégorie d'âge ⇒ AMBIGUOUS", () => {
    const a = competition({ nom: "Open International de Metz", dateDebut: new Date("2026-11-08T00:00:00Z") });
    const b = competition({ nom: "Grand Open de Metz", dateDebut: new Date("2026-11-08T00:00:00Z") });
    const result = matchCompetitions(a, b);
    expect(result.confidence).toBe("AMBIGUOUS");
    expect(result.reasons.join(" ")).toMatch(/open|metz/);
  });

  it("dates de début différentes ⇒ toujours DIFFERENT, quel que soit le nom", () => {
    const a = competition({ nom: "Championnat de France Seniors", dateDebut: new Date("2026-02-21T00:00:00Z") });
    const b = competition({ nom: "Championnat de France Seniors", dateDebut: new Date("2026-02-22T00:00:00Z") });
    expect(matchCompetitions(a, b).confidence).toBe("DIFFERENT");
  });

  it("résultat toujours explicable (reasons non vide, quel que soit le niveau de confiance)", () => {
    for (const [a, b] of [
      [fftdaSeniors, meSeniors],
      [fftdaPoissy, mePoissy],
      [meBordeaux, fftdaSeniors],
    ] as const) {
      expect(matchCompetitions(a, b).reasons.length).toBeGreaterThan(0);
    }
  });
});
