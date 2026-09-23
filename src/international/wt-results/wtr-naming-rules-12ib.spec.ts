// Régression #12I-B : les 18 cas naming/multi-candidate figés par #12I-A
// (~/ekvara-checkpoints/12I-A/cases/frozen_naming_v3.json +
// multi_candidate_v3.json), rejoués avec les données RÉELLES observées
// (noms et dates exacts de production). Invariant : exactement 13 deviennent
// SAFE (via YEAR_TOKEN_STRIP et/ou ORDINAL_NORMALIZATION), 5 restent
// UNMATCHED (cas nécessitant une logique non générique, hors périmètre), et
// le cas Pan-Am (déjà identifié comme n'ayant aucun candidat réel) reste
// UNMATCHED sans jamais accrocher "Swiss Open".
import { CalendarCandidate, mapResultsCompetition, WtrCompetitionRef } from "./wtr-competition-matcher";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

function results(slug: string, name: string, start: string, end: string): WtrCompetitionRef {
  return { slug, name, dateStart: d(start), dateEnd: d(end) };
}

function candidate(id: string, nom: string, start: string, end: string | null): CalendarCandidate {
  return { competitionId: id, nom, dateDebut: d(start), dateFin: end ? d(end) : null };
}

// Les 13 cas qui doivent devenir SAFE (11 du périmètre 2025 + Spanish Open
// résolu par ambiguïté + Fujairah via ordinal ; bosnia-open-2026 est hors
// périmètre 2025 et testé séparément dans le corpus complet, pas ici).
const EXPECTED_SAFE: Array<{ slug: string; name: string; start: string; end: string; candId: string; candNom: string; candStart: string; candEnd: string | null }> = [
  { slug: "belgian-open-2025", name: "Belgian Open 2025", start: "2025-03-15", end: "2025-03-16", candId: "a67c43c4-e509-422b-9a63-a30360c6558d", candNom: "Belgian Open", candStart: "2025-03-15", candEnd: "2025-03-16" },
  { slug: "tallinn-open-2025", name: "Tallinn Open 2025", start: "2025-04-15", end: "2025-04-15", candId: "0e11e470-b0f3-4c95-8063-e715e089f8ff", candNom: "Tallinn Open", candStart: "2025-04-15", candEnd: null },
  { slug: "austrian-open-2025", name: "Austrian Open 2025", start: "2025-06-14", end: "2025-06-15", candId: "dd581691-44f2-415e-81ba-4c9c21bebf46", candNom: "Austrian Open", candStart: "2025-06-14", candEnd: "2025-06-15" },
  { slug: "kazakhstan-open-2025", name: "Kazakhstan Open 2025", start: "2025-08-14", end: "2025-08-16", candId: "5d4183fd-82fd-4ccd-85f4-9ff6f96e9245", candNom: "Kazakhstan Open", candStart: "2025-08-14", candEnd: "2025-08-16" },
  { slug: "wt-presidents-cup-oceania-2025", name: "WT President's Cup Oceania 2025", start: "2025-08-14", end: "2025-08-15", candId: "5e45be79-6f64-41c3-aadd-34d4d928818d", candNom: "WT President's Cup - Oceania", candStart: "2025-08-14", candEnd: "2025-08-15" },
  { slug: "australian-open-2025", name: "Australian Open 2025", start: "2025-08-16", end: "2025-08-17", candId: "4d8c678d-9985-4bbb-83f0-e92710db30a7", candNom: "Australian Open", candStart: "2025-08-16", candEnd: "2025-08-17" },
  { slug: "swiss-open-2025", name: "Swiss Open 2025", start: "2025-09-06", end: "2025-09-07", candId: "80bfa76a-93d3-4aa0-a8ff-5c751d5c4bf2", candNom: "Swiss Open", candStart: "2025-09-06", candEnd: "2025-09-07" },
  { slug: "polish-open-2025", name: "Polish Open 2025", start: "2025-09-20", end: "2025-09-21", candId: "9d0f1d65-68c7-44e7-8429-97c20fda7de7", candNom: "Polish Open", candStart: "2025-09-20", candEnd: "2025-09-21" },
  { slug: "riga-open-2025", name: "Riga Open 2025", start: "2025-10-04", end: "2025-10-05", candId: "0c9f5828-bde8-49b2-afe3-0e014341d9aa", candNom: "Riga Open", candStart: "2025-10-04", candEnd: "2025-10-05" },
  { slug: "2025-african-open-series-final", name: "2025 African Open Series - Final", start: "2025-11-27", end: "2025-11-29", candId: "79a1219c-097d-4a01-ba76-2712dd09a5b1", candNom: "African Open Series Final", candStart: "2025-11-27", candEnd: "2025-11-29" },
  { slug: "fujairah-open-2025", name: "Fujairah Open 2025", start: "2025-02-09", end: "2025-02-13", candId: "f75a97dc-fee6-4ce1-9c80-3d9bf4c7a8ef", candNom: "12th Fujairah Open 2025", candStart: "2025-02-09", candEnd: "2025-02-13" },
];

// spanish-open-2025 : cas multi-candidat, résolu SAFE une fois le token année
// retiré (un seul des deux candidats reste compatible en mots distinctifs).
const SPANISH_OPEN = {
  slug: "spanish-open-2025",
  name: "Spanish Open 2025",
  start: "2025-04-25",
  end: "2025-04-27",
  candidates: [
    candidate("0cf10db4-d81e-4169-a11d-1b30e80990f6", "2025 WT President's Cup - Africa", "2025-04-25", "2025-04-27"),
    candidate("ee06dde3-787d-4796-98e6-049aa9b05e4b", "Spanish Open", "2025-04-25", "2025-04-27"),
  ],
  expectedCandId: "ee06dde3-787d-4796-98e6-049aa9b05e4b",
};

// Les 5 cas qui doivent rester UNMATCHED (logique non générique nécessaire :
// abréviation, mot composé, préfixe de ville, synonymes spécifiques au domaine).
const EXPECTED_STILL_UNMATCHED: Array<{ slug: string; name: string; start: string; end: string; candNom: string; candStart: string; candEnd: string | null }> = [
  { slug: "arab-cup-2025", name: "Arab Cup 2025", start: "2025-02-05", end: "2025-02-07", candNom: "Fujairah 5th Arab Cup 2025", candStart: "2025-02-05", candEnd: "2025-02-07" },
  { slug: "luxembourg-open-2025", name: "Luxembourg Open 2025", start: "2025-06-07", end: "2025-06-08", candNom: "Lux Open 2025", candStart: "2025-06-07", candEnd: "2025-06-08" },
  { slug: "the-1st-cj-viet-nam-open-2025", name: "The 1st CJ Viet Nam Open 2025", start: "2025-06-27", end: "2025-06-28", candNom: "The 1st CJ Vietnam Open 2025", candStart: "2025-06-27", candEnd: "2025-06-28" },
  { slug: "european-small-states-championships-2025", name: "European Small States Championships 2025", start: "2025-10-02", end: "2025-10-03", candNom: "3rd Small States Countries Championships", candStart: "2025-10-02", candEnd: "2025-10-03" },
  { slug: "33rd-sea-games-thailand-2025", name: "33rd SEA Games Thailand 2025", start: "2025-12-10", end: "2025-12-13", candNom: "2025 Southeast Asian Games", candStart: "2025-12-10", candEnd: "2025-12-13" },
];

// Pan-Am : AUCUN candidat réel (identifié comme misclassifié par #12I-A). La
// seule compétition partageant sa date est "Swiss Open", un nom totalement
// disjoint. Doit rester UNMATCHED même après les deux nouvelles règles.
const PAN_AM = results("2025-wt-presidents-cup-pan-am", "2025 WT President's Cup - Pan Am", "2025-09-06", "2025-09-07");
const PAN_AM_SPURIOUS_CANDIDATE = candidate("80bfa76a-93d3-4aa0-a8ff-5c751d5c4bf2", "Swiss Open", "2025-09-06", "2025-09-07");

describe("#12I-B régression — 18 cas naming/multi-candidate figés par #12I-A", () => {
  describe("13 cas qui doivent devenir SAFE (identité canonique exacte)", () => {
    for (const c of EXPECTED_SAFE) {
      it(`${c.slug} ⇒ SAFE, competitionId=${c.candId}`, () => {
        const r = mapResultsCompetition(
          results(c.slug, c.name, c.start, c.end),
          [candidate(c.candId, c.candNom, c.candStart, c.candEnd)],
        );
        expect(r.verdict).toBe("SAFE");
        expect(r.competitionId).toBe(c.candId);
      });
    }

    it("spanish-open-2025 ⇒ SAFE sur le bon candidat (ambiguïté résolue par retrait de l'année)", () => {
      const r = mapResultsCompetition(
        results(SPANISH_OPEN.slug, SPANISH_OPEN.name, SPANISH_OPEN.start, SPANISH_OPEN.end),
        SPANISH_OPEN.candidates,
      );
      expect(r.verdict).toBe("SAFE");
      expect(r.competitionId).toBe(SPANISH_OPEN.expectedCandId);
    });
  });

  describe("5 cas qui doivent RESTER UNMATCHED (règles génériques insuffisantes, volontairement non résolus)", () => {
    for (const c of EXPECTED_STILL_UNMATCHED) {
      it(`${c.slug} ⇒ toujours UNMATCHED`, () => {
        const r = mapResultsCompetition(
          results(c.slug, c.name, c.start, c.end),
          [candidate("irrelevant-id", c.candNom, c.candStart, c.candEnd)],
        );
        expect(r.verdict).toBe("UNMATCHED");
        expect(r.competitionId).toBeNull();
      });
    }
  });

  describe("cas Pan-Am (aucun candidat réel, ne doit jamais s'accrocher à Swiss Open)", () => {
    it("2025-wt-presidents-cup-pan-am ⇒ UNMATCHED même avec la même date que Swiss Open", () => {
      const r = mapResultsCompetition(PAN_AM, [PAN_AM_SPURIOUS_CANDIDATE]);
      expect(r.verdict).toBe("UNMATCHED");
      expect(r.competitionId).toBeNull();
    });
  });

  describe("invariant global : total du périmètre 2025 (18 cas figés par #12I-A)", () => {
    it("11 SAFE (année/ordinal) + 1 SAFE (spanish-open, ambiguïté résolue) + 5 UNMATCHED + 1 Pan-Am UNMATCHED = 18", () => {
      expect(EXPECTED_SAFE.length).toBe(11);
      expect(EXPECTED_STILL_UNMATCHED.length).toBe(5);
      expect(EXPECTED_SAFE.length + 1 + EXPECTED_STILL_UNMATCHED.length + 1).toBe(18);
    });
  });
});
