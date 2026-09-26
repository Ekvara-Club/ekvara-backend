import {
  CalendarCandidate,
  divisionDiscipline,
  DivisionCandidate,
  mapResultsCompetition,
  mapResultsCompetitionByDivisions,
  resultsDisciplineFromCategories,
  WtrCompetitionRef,
} from "./wtr-competition-matcher";

// #22 — rapprochement Results ↔ calendrier par divisions. Fixtures = formes
// réelles persistées dans competition_source.raw_divisions (import 26/09/2026).

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

function results(slug: string, name: string, start: string, end = start): WtrCompetitionRef {
  return { slug, name, dateStart: d(start), dateEnd: d(end) };
}

function division(dateText: string, discipline: string | null, start: string | null, end: string | null = start) {
  return { dateText, discipline, start, end };
}

function candidate(id: string, nom: string, start: string, end: string | null, divisions: unknown): DivisionCandidate {
  return { competitionId: id, nom, dateDebut: d(start), dateFin: end ? d(end) : null, divisions };
}

// 26345 — WT President's Cup - Europe, Nuremberg (calendrier 4–7 juin, Results « 7 Jun 2026 »).
const PC_EUROPE_2026 = candidate("d75b3bc6", "WT President's Cup - Europe", "2026-06-04", "2026-06-07", [
  division("June 4", "Kyorugi / Cadet", "2026-06-04"),
  division("June 5", "Kyorugi / Junior", "2026-06-05"),
  division("June 6-7", "Kyorugi / Senior", "2026-06-06", "2026-06-07"),
]);
// 25609 — même nom en 2025 (Innsbruck, Poomsae seul).
const PC_EUROPE_2025_POOMSAE = candidate("a3c8a989", "WT President's Cup - Europe", "2025-11-29", "2025-11-30", [
  division("November 29-30", "Poomsae", "2025-11-29", "2025-11-30"),
]);
const PC_RESULTS = results("wt-presidents-cup-europe-2026", "WT President's Cup Europe 2026", "2026-06-07");

// 26044 / 26448 — Skopje Open Ramus 2026 : Kyorugi et Poomsae publiés en deux entrées homonymes.
const SKOPJE_KYORUGI = candidate("f3aa5be9", "Skopje Open Ramus 2026", "2026-04-04", "2026-04-05", [
  division("April 4", "Kyorugi / Cadet / Junior", "2026-04-04"),
  division("April 5", "Kyorugi / Senior", "2026-04-05"),
]);
const SKOPJE_POOMSAE = candidate("b0048030", "Skopje Open Ramus 2026", "2026-04-04", "2026-04-05", [
  division("April 4-5", "Poomsae", "2026-04-04", "2026-04-05"),
]);

const KYORUGI = "KYORUGI" as const;

describe("resultsDisciplineFromCategories", () => {
  it("prouve le Kyorugi seulement si toutes les catégories sont des catégories de poids", () => {
    expect(resultsDisciplineFromCategories(["Men -54kg", "Women +73kg", "Boys -45kg", "K44 Men -58kg"])).toBe("KYORUGI");
    expect(resultsDisciplineFromCategories(["Men -54kg", "Individual Female Under 30"])).toBe("UNKNOWN");
    expect(resultsDisciplineFromCategories([])).toBe("UNKNOWN");
  });
});

describe("divisionDiscipline", () => {
  it("ne lit que le premier segment écrit par la source, sans rien inférer", () => {
    expect(divisionDiscipline("Kyorugi / Senior")).toBe("KYORUGI");
    expect(divisionDiscipline("Kyorugi")).toBe("KYORUGI");
    expect(divisionDiscipline("Poomsae")).toBe("POOMSAE");
    expect(divisionDiscipline("Senior")).toBe("UNSTATED"); // format 2025
    expect(divisionDiscipline("Cadet / Junior")).toBe("UNSTATED");
    expect(divisionDiscipline(null)).toBe("UNSTATED");
  });
});

describe("mapResultsCompetitionByDivisions", () => {
  it("President's Cup Europe 2026 : 7 juin ⊂ 4–7 juin, couvert par Kyorugi / Senior ⇒ SAFE", () => {
    const r = mapResultsCompetitionByDivisions(PC_RESULTS, [PC_EUROPE_2026, PC_EUROPE_2025_POOMSAE], [PC_RESULTS], KYORUGI);
    expect(r.verdict).toBe("SAFE");
    expect(r.competitionId).toBe("d75b3bc6");
  });

  it("la règle exacte reste prioritaire et inchangée : même dates ⇒ SAFE sans divisions", () => {
    const exactCandidate: CalendarCandidate = { competitionId: "roma", nom: "Roma 2026 World Taekwondo Grand Prix Series", dateDebut: d("2026-06-05"), dateFin: d("2026-06-07") };
    const r = mapResultsCompetition(results("roma-2026-world-taekwondo-grand-prix", "Roma 2026 World Taekwondo Grand-Prix", "2026-06-05", "2026-06-07"), [exactCandidate]);
    expect(r.verdict).toBe("SAFE");
    // et la règle exacte n'accepte toujours pas un simple jour contenu
    expect(mapResultsCompetition(PC_RESULTS, [PC_EUROPE_2026]).verdict).toBe("UNMATCHED");
  });

  it("plage Results multi-jours contenue et entièrement couverte par des divisions Kyorugi ⇒ SAFE", () => {
    const turkiye = candidate("628872f5", "13th Turkiye Open", "2026-03-24", "2026-03-31", [
      division("March 24", "Poomsae", "2026-03-24"),
      division("March 26-27", "Kyorugi / Cadet", "2026-03-26", "2026-03-27"),
      division("March 28-29", "Kyorugi / Junior", "2026-03-28", "2026-03-29"),
      division("March 30-31", "Kyorugi / Senior", "2026-03-30", "2026-03-31"),
    ]);
    const res = results("13th-turkiye-open", "13th Turkiye Open", "2026-03-30", "2026-03-31");
    expect(mapResultsCompetitionByDivisions(res, [turkiye], [res], KYORUGI).competitionId).toBe("628872f5");
    // un jour Poomsae dans la plage Results suffit à refuser
    const withPoomsaeDay = results("x", "13th Turkiye Open", "2026-03-24", "2026-03-26");
    expect(mapResultsCompetitionByDivisions(withPoomsaeDay, [turkiye], [withPoomsaeDay], KYORUGI).verdict).toBe("UNMATCHED");
  });

  it("Skopje : l'entrée Poomsae homonyme est exclue, l'entrée Kyorugi est retenue", () => {
    const res = results("skopje-open-ramus-2026", "Skopje Open Ramus 2026", "2026-04-05");
    const r = mapResultsCompetitionByDivisions(res, [SKOPJE_POOMSAE, SKOPJE_KYORUGI], [res], KYORUGI);
    expect(r.verdict).toBe("SAFE");
    expect(r.competitionId).toBe("f3aa5be9");
  });

  it("une entrée Poomsae seule n'est jamais retenue pour un Results Kyorugi", () => {
    const res = results("skopje-open-ramus-2026", "Skopje Open Ramus 2026", "2026-04-05");
    expect(mapResultsCompetitionByDivisions(res, [SKOPJE_POOMSAE], [res], KYORUGI).verdict).toBe("UNMATCHED");
  });

  it("plusieurs candidates Kyorugi compatibles ⇒ AMBIGUOUS", () => {
    const twin = { ...PC_EUROPE_2026, competitionId: "twin" };
    const r = mapResultsCompetitionByDivisions(PC_RESULTS, [PC_EUROPE_2026, twin], [PC_RESULTS], KYORUGI);
    expect(r.verdict).toBe("AMBIGUOUS");
    expect(r.competitionId).toBeNull();
  });

  it("une autre candidate homonyme indécidable (divisions absentes ou sans discipline) ⇒ AMBIGUOUS", () => {
    const noDivisions = { ...PC_EUROPE_2026, competitionId: "no-div", divisions: null };
    const unstated = { ...PC_EUROPE_2026, competitionId: "unstated", divisions: [division("June 7", "Senior", "2026-06-07")] };
    expect(mapResultsCompetitionByDivisions(PC_RESULTS, [PC_EUROPE_2026, noDivisions], [PC_RESULTS], KYORUGI).verdict).toBe("AMBIGUOUS");
    expect(mapResultsCompetitionByDivisions(PC_RESULTS, [PC_EUROPE_2026, unstated], [PC_RESULTS], KYORUGI).verdict).toBe("AMBIGUOUS");
  });

  it("un autre événement Results homonyme dans la plage de la candidate ⇒ AMBIGUOUS", () => {
    const rival = results("wt-presidents-cup-europe-2026-day-2", "WT President's Cup - Europe 2026", "2026-06-06");
    const r = mapResultsCompetitionByDivisions(PC_RESULTS, [PC_EUROPE_2026], [PC_RESULTS, rival], KYORUGI);
    expect(r.verdict).toBe("AMBIGUOUS");
  });

  it("Results hors de la plage calendrier (même partiellement) ⇒ UNMATCHED", () => {
    for (const [start, end] of [["2026-06-08", "2026-06-08"], ["2026-06-03", "2026-06-03"], ["2026-06-07", "2026-06-08"], ["2026-06-03", "2026-06-07"]]) {
      const res = results("wt-presidents-cup-europe-2026", "WT President's Cup Europe 2026", start, end);
      expect(mapResultsCompetitionByDivisions(res, [PC_EUROPE_2026], [res], KYORUGI).verdict).toBe("UNMATCHED");
    }
  });

  it("même nom, autre année : jamais retenu", () => {
    const res2025 = results("wt-presidents-cup-europe-2025", "WT President's Cup Europe 2025", "2025-06-07");
    expect(mapResultsCompetitionByDivisions(res2025, [PC_EUROPE_2026], [res2025], KYORUGI).verdict).toBe("UNMATCHED");
    const shifted = candidate("pc-2025-kyorugi", "WT President's Cup - Europe", "2025-06-04", "2025-06-07", [division("June 6-7", "Kyorugi / Senior", "2025-06-06", "2025-06-07")]);
    const r = mapResultsCompetitionByDivisions(PC_RESULTS, [shifted, PC_EUROPE_2026], [PC_RESULTS], KYORUGI);
    expect(r.competitionId).toBe("d75b3bc6");
  });

  it("divisions absentes ⇒ UNMATCHED (jamais de rattachement sans preuve)", () => {
    for (const divisions of [null, undefined, []]) {
      const r = mapResultsCompetitionByDivisions(PC_RESULTS, [{ ...PC_EUROPE_2026, divisions }], [PC_RESULTS], KYORUGI);
      expect(r.verdict).toBe("UNMATCHED");
    }
  });

  it("divisions illisibles ⇒ UNMATCHED", () => {
    const malformed: unknown[] = [
      { not: "an array" },
      [division("June 6-7", "Kyorugi / Senior", "2026-06-07", "2026-06-06")], // fin avant début
      [{ dateText: "June 6-7", start: "2026-06-06", end: "2026-06-07" }], // discipline manquante
      [{ dateText: "June 6-7", discipline: "Kyorugi / Senior", start: "06/06/2026", end: "07/06/2026" }],
      [{ dateText: "June 6-7", discipline: "Kyorugi / Senior", start: "2026-06-06", end: null }],
      ["June 6-7"],
    ];
    for (const divisions of malformed) {
      const r = mapResultsCompetitionByDivisions(PC_RESULTS, [{ ...PC_EUROPE_2026, divisions }], [PC_RESULTS], KYORUGI);
      expect(r.verdict).toBe("UNMATCHED");
    }
  });

  it("division 2025 sans discipline déclarée (« Senior ») : jamais interprétée comme Kyorugi ⇒ UNMATCHED", () => {
    const bosnia = candidate("0fb55e9b", "Bosnia and Herzegovina Open 2025", "2025-11-29", "2025-11-30", [
      division("November 29", "Cadet / Junior", "2025-11-29"),
      division("November 30", "Senior", "2025-11-30"),
    ]);
    const res = results("bosnia-and-herzegovina-open-2025", "Bosnia and Herzegovina Open 2025", "2025-11-30");
    expect(mapResultsCompetitionByDivisions(res, [bosnia], [res], KYORUGI).verdict).toBe("UNMATCHED");
  });

  it("une division à date illisible non Poomsae empêche de conclure sur un jour non couvert", () => {
    const withUndated = { ...PC_EUROPE_2026, divisions: [division("June 4-6", "Kyorugi / Senior", "2026-06-04", "2026-06-06"), division("Jnue 7", "Kyorugi / Junior", null)] };
    expect(mapResultsCompetitionByDivisions(PC_RESULTS, [withUndated], [PC_RESULTS], KYORUGI).verdict).toBe("UNMATCHED");
  });

  it("discipline Results non prouvée ⇒ UNMATCHED", () => {
    expect(mapResultsCompetitionByDivisions(PC_RESULTS, [PC_EUROPE_2026], [PC_RESULTS], "UNKNOWN").verdict).toBe("UNMATCHED");
  });

  it("nom différent ou trop générique ⇒ UNMATCHED", () => {
    const other = results("wt-presidents-cup-oceania-2026", "WT President's Cup Oceania 2026", "2026-06-07");
    expect(mapResultsCompetitionByDivisions(other, [PC_EUROPE_2026], [other], KYORUGI).verdict).toBe("UNMATCHED");
    const generic = results("open", "Open 2026", "2026-06-07");
    expect(mapResultsCompetitionByDivisions(generic, [{ ...PC_EUROPE_2026, nom: "Open" }], [generic], KYORUGI).verdict).toBe("UNMATCHED");
  });
});
