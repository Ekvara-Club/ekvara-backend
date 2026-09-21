import { isActivePreparation, resolveCoachPreparations } from "./athlete-coach-preparations";
import type { AthletePreparationRow } from "./participations.repository";

function competitionRow(id: string, nom: string, dateDebut: string): AthletePreparationRow["competition"] {
  return {
    id,
    nom,
    date_debut: new Date(`${dateDebut}T00:00:00.000Z`),
    date_fin: null,
    lieu: "Athletica",
    ville: "Eaubonne",
    pays: "France",
    niveau: "national",
    sources: [{ source: "fftda" }],
  };
}

const CHAMPIONNAT = competitionRow("c-champ", "Championnat de France seniors", "2027-03-13");
const OPEN = competitionRow("c-open", "Open de Bordeaux", "2026-11-01");

function row(overrides: Partial<AthletePreparationRow> & Pick<AthletePreparationRow, "competition">): AthletePreparationRow {
  return {
    competition_id: overrides.competition.id,
    statut: "pret",
    categorie_age_prevue: "Senior",
    categorie_poids_prevue: "-68kg",
    ...overrides,
  };
}

describe("resolveCoachPreparations", () => {
  it("expose la vue Athlete-safe : statut, catégories prévues, compétition — source coach_preparation", () => {
    const [view] = resolveCoachPreparations([row({ competition: CHAMPIONNAT })]);

    expect(view).toEqual({
      competitionId: "c-champ",
      source: "coach_preparation",
      status: "pret",
      categorieAgePrevue: "Senior",
      categoriePoidsPrevue: "-68kg",
      competition: {
        id: "c-champ",
        nom: "Championnat de France seniors",
        dateDebut: CHAMPIONNAT.date_debut,
        dateFin: null,
        lieu: "Athletica",
        ville: "Eaubonne",
        pays: "France",
        niveau: "national",
        source: "fftda",
      },
    });
  });

  it("n'expose jamais de champ privé coach, même si la ligne source en contient (défense en profondeur)", () => {
    const leaky = {
      ...row({ competition: CHAMPIONNAT }),
      note_coach: "NOTE-SECRETE",
      objectif: "OBJECTIF-SECRET",
      coach_id: "coach-1",
      id: "prep-1",
    } as AthletePreparationRow;

    const serialized = JSON.stringify(resolveCoachPreparations([leaky]));

    expect(serialized).not.toContain("NOTE-SECRETE");
    expect(serialized).not.toContain("OBJECTIF-SECRET");
    expect(serialized).not.toMatch(/note_coach|coachNote|objectif|objective|coach_id|coachId/);
  });

  it("deux coachs, même compétition -> UNE seule entrée", () => {
    const views = resolveCoachPreparations([
      row({ competition: CHAMPIONNAT, statut: "selectionne" }),
      row({ competition: CHAMPIONNAT, statut: "envisage" }),
    ]);

    expect(views).toHaveLength(1);
  });

  it("deux coachs, statuts différents -> le plus avancé l'emporte (règle déterministe, indépendante de l'ordre)", () => {
    const a = row({ competition: CHAMPIONNAT, statut: "envisage" });
    const b = row({ competition: CHAMPIONNAT, statut: "pret" });

    expect(resolveCoachPreparations([a, b])[0].status).toBe("pret");
    expect(resolveCoachPreparations([b, a])[0].status).toBe("pret");
  });

  it("deux coachs, catégories identiques -> exposées", () => {
    const [view] = resolveCoachPreparations([
      row({ competition: CHAMPIONNAT, categorie_poids_prevue: "-68kg" }),
      row({ competition: CHAMPIONNAT, categorie_poids_prevue: " -68kg " }),
    ]);

    expect(view.categoriePoidsPrevue).toBe("-68kg");
  });

  it("deux coachs, catégories contradictoires -> non exposée (null), jamais un choix arbitraire", () => {
    const [view] = resolveCoachPreparations([
      row({ competition: CHAMPIONNAT, categorie_age_prevue: "Senior", categorie_poids_prevue: "-68kg" }),
      row({ competition: CHAMPIONNAT, categorie_age_prevue: "Senior", categorie_poids_prevue: "-74kg" }),
    ]);

    expect(view.categoriePoidsPrevue).toBeNull();
    expect(view.categorieAgePrevue).toBe("Senior");
  });

  it("un coach renseigne la catégorie, l'autre non -> exposée (pas de contradiction)", () => {
    const [view] = resolveCoachPreparations([
      row({ competition: CHAMPIONNAT, categorie_poids_prevue: null }),
      row({ competition: CHAMPIONNAT, categorie_poids_prevue: "-68kg" }),
    ]);

    expect(view.categoriePoidsPrevue).toBe("-68kg");
  });

  it("forfait d'un seul coach: l'autre coach actif garde la compétition active, ses valeurs priment", () => {
    const [view] = resolveCoachPreparations([
      row({ competition: CHAMPIONNAT, statut: "forfait", categorie_poids_prevue: "-74kg" }),
      row({ competition: CHAMPIONNAT, statut: "selectionne", categorie_poids_prevue: "-68kg" }),
    ]);

    expect(view.status).toBe("selectionne");
    expect(view.categoriePoidsPrevue).toBe("-68kg");
    expect(isActivePreparation(view)).toBe(true);
  });

  it("forfait de tous les coachs -> statut forfait, non active", () => {
    const [view] = resolveCoachPreparations([
      row({ competition: CHAMPIONNAT, statut: "forfait" }),
      row({ competition: CHAMPIONNAT, statut: "forfait" }),
    ]);

    expect(view.status).toBe("forfait");
    expect(isActivePreparation(view)).toBe(false);
  });

  it("plusieurs compétitions -> triées par date de début croissante", () => {
    const views = resolveCoachPreparations([row({ competition: CHAMPIONNAT }), row({ competition: OPEN })]);

    expect(views.map((v) => v.competitionId)).toEqual(["c-open", "c-champ"]);
  });

  it("aucune ligne -> liste vide", () => {
    expect(resolveCoachPreparations([])).toEqual([]);
  });
});
