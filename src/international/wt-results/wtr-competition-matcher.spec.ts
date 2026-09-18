import {
  CalendarCandidate,
  mapResultsCompetition,
  normalizeCompetitionName,
  WtrCompetitionRef,
} from "./wtr-competition-matcher";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

function results(slug: string, name: string, start: string, end = start): WtrCompetitionRef {
  return { slug, name, dateStart: d(start), dateEnd: d(end) };
}

function candidate(id: string, nom: string, start: string, end: string | null): CalendarCandidate {
  return { competitionId: id, nom, dateDebut: d(start), dateFin: end ? d(end) : null };
}

// Cas réels observés le 19/09/2026 (calendrier WT dans la base de dev ↔ site
// Results) : identifiants calendrier 25980 / 26022 / 26018.
const TASHKENT = candidate("c-tashkent", "Tashkent 2026 World Taekwondo Junior Championships", "2026-04-12", "2026-04-17");
const MUJU = candidate("c-muju", "Muju Taekwondowon 2026 World Taekwondo Grand Prix Series", "2026-09-05", "2026-09-07");
const ROMA = candidate("c-roma", "Roma 2026 World Taekwondo Grand Prix Series", "2026-06-05", "2026-06-07");

describe("mapResultsCompetition", () => {
  describe("cas réels", () => {
    it("Tashkent : mêmes dates + même nom ⇒ SAFE", () => {
      const r = mapResultsCompetition(
        results("tashkent-2026-world-taekwondo-junior-championships", "Tashkent 2026 World Taekwondo Junior Championships", "2026-04-12", "2026-04-17"),
        [TASHKENT, MUJU, ROMA],
      );
      expect(r.verdict).toBe("SAFE");
      expect(r.competitionId).toBe("c-tashkent");
    });

    it("Muju : mêmes dates + même nom ⇒ SAFE", () => {
      const r = mapResultsCompetition(
        results("muju-taekwondowon-2026-world-taekwondo-grand-prix-series", "Muju Taekwondowon 2026 World Taekwondo Grand Prix Series", "2026-09-05", "2026-09-07"),
        [TASHKENT, MUJU, ROMA],
      );
      expect(r.verdict).toBe("SAFE");
      expect(r.competitionId).toBe("c-muju");
    });

    it('Roma : "Grand-Prix" (Results) ↔ "Grand Prix Series" (calendrier), mêmes dates ⇒ SAFE grâce au mot générique "series"', () => {
      const r = mapResultsCompetition(
        results("roma-2026-world-taekwondo-grand-prix", "Roma 2026 World Taekwondo Grand-Prix", "2026-06-05", "2026-06-07"),
        [TASHKENT, MUJU, ROMA],
      );
      expect(r.verdict).toBe("SAFE");
      expect(r.competitionId).toBe("c-roma");
    });

    it("Para Grand Prix Series de Roma (4 juin, autre compétition) ⇒ pas de rattachement à la compétition valide", () => {
      const r = mapResultsCompetition(
        results("roma-2026-world-para-taekwondo-grand-prix-series", "Roma 2026 World Para Taekwondo Grand Prix Series", "2026-06-04"),
        [TASHKENT, MUJU, ROMA],
      );
      expect(r.verdict).toBe("UNMATCHED");
      expect(r.competitionId).toBeNull();
    });

    it("l'apostrophe ne casse pas la comparaison (Women's Open)", () => {
      const r = mapResultsCompetition(
        results("taiyuan-2026-world-taekwondo-women-s-open-championships", "Taiyuan 2026 World Taekwondo Women’s Open Championships", "2026-08-28", "2026-08-30"),
        [candidate("c-taiyuan", "Taiyuan 2026 World Taekwondo Women's Open Championships", "2026-08-28", "2026-08-30")],
      );
      expect(r.verdict).toBe("SAFE");
    });
  });

  describe("règles", () => {
    it("date_fin absente côté EKVARA ⇒ traitée comme la date de début (compétition d'un jour)", () => {
      const r = mapResultsCompetition(
        results("london-open-poomsae-2026", "London Open Poomsae 2026", "2026-05-02"),
        [candidate("c-london", "London Open Poomsae 2026", "2026-05-02", null)],
      );
      expect(r.verdict).toBe("SAFE");
    });

    it("même nom mais dates incompatibles ⇒ UNMATCHED (jamais de rattachement sur le nom seul)", () => {
      const r = mapResultsCompetition(
        results("tashkent-2026-world-taekwondo-junior-championships", "Tashkent 2026 World Taekwondo Junior Championships", "2026-05-12", "2026-05-17"),
        [TASHKENT],
      );
      expect(r.verdict).toBe("UNMATCHED");
      expect(r.reasons[0]).toMatch(/mêmes dates/);
    });

    it("date de fin différente (début identique) ⇒ UNMATCHED", () => {
      const r = mapResultsCompetition(
        results("tashkent-2026-world-taekwondo-junior-championships", "Tashkent 2026 World Taekwondo Junior Championships", "2026-04-12", "2026-04-18"),
        [TASHKENT],
      );
      expect(r.verdict).toBe("UNMATCHED");
    });

    it("mêmes dates mais nom faible (un seul mot en commun) ⇒ UNMATCHED", () => {
      const r = mapResultsCompetition(
        results("tashkent-open-2026", "Tashkent Open 2026", "2026-04-12", "2026-04-17"),
        [TASHKENT],
      );
      expect(r.verdict).toBe("UNMATCHED");
      expect(r.reasons.join(" ")).toMatch(/candidat écarté/);
    });

    it("nom Results trop générique après normalisation ⇒ UNMATCHED même avec dates identiques", () => {
      const r = mapResultsCompetition(
        results("world-taekwondo", "World Taekwondo Series", "2026-04-12", "2026-04-17"),
        [candidate("c-x", "World Taekwondo Series", "2026-04-12", "2026-04-17")],
      );
      expect(r.verdict).toBe("UNMATCHED");
      expect(r.reasons[0]).toMatch(/trop générique/);
    });

    it("plusieurs candidates canoniques équivalentes ⇒ AMBIGUOUS, aucun rattachement", () => {
      const r = mapResultsCompetition(
        results("tashkent-2026-world-taekwondo-junior-championships", "Tashkent 2026 World Taekwondo Junior Championships", "2026-04-12", "2026-04-17"),
        [TASHKENT, candidate("c-tashkent-bis", "Tashkent 2026 Junior Championships", "2026-04-12", "2026-04-17")],
      );
      expect(r.verdict).toBe("AMBIGUOUS");
      expect(r.competitionId).toBeNull();
    });

    it("deux compétitions Results équivalentes pour la même candidate ⇒ AMBIGUOUS", () => {
      const a = results("roma-2026-world-taekwondo-grand-prix", "Roma 2026 World Taekwondo Grand-Prix", "2026-06-05", "2026-06-07");
      const b = results("roma-2026-grand-prix-series", "Roma 2026 Grand Prix Series", "2026-06-05", "2026-06-07");
      const r = mapResultsCompetition(a, [ROMA], [a, b]);
      expect(r.verdict).toBe("AMBIGUOUS");
      expect(r.reasons[0]).toContain("roma-2026-grand-prix-series");
    });

    it("aucune candidate ⇒ UNMATCHED", () => {
      expect(
        mapResultsCompetition(results("x-2026-open", "Xyz 2026 Open Cup", "2026-01-01"), []).verdict,
      ).toBe("UNMATCHED");
    });

    it("ne modifie jamais les entrées", () => {
      const candidates = [TASHKENT, MUJU];
      const snapshot = JSON.stringify(candidates);
      mapResultsCompetition(results("muju-taekwondowon-2026-world-taekwondo-grand-prix-series", "Muju Taekwondowon 2026 World Taekwondo Grand Prix Series", "2026-09-05", "2026-09-07"), candidates);
      expect(JSON.stringify(candidates)).toBe(snapshot);
    });
  });

  describe("normalizeCompetitionName", () => {
    it("retire accents, apostrophes, ponctuation et mots génériques, trie et déduplique", () => {
      expect(normalizeCompetitionName("Roma 2026 World Taekwondo Grand-Prix")).toBe("2026 grand prix roma");
      expect(normalizeCompetitionName("Roma 2026 World Taekwondo Grand Prix Series")).toBe("2026 grand prix roma");
      expect(normalizeCompetitionName("Niš  Open — 2026 ’Cup’")).toBe("2026 cup nis open");
    });
  });
});
