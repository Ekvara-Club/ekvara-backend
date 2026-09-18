import {
  competitionResultsUrl,
  matchUrl,
  parseCompetitionList,
  parseMatchPage,
  parseProfilePage,
  parseResultsListing,
  parseWtrDateRange,
  profileUrl,
  WT_RESULTS_SOURCE,
} from "./wtr-parser";
import {
  ALICE,
  BRUNO,
  CHLOE,
  competitionListHtml,
  MATCH_1_ID,
  MATCH_2_ID,
  matchPageHtml,
  profilePageHtml,
  resultsListHtml,
} from "./wtr-test-fixtures";

describe("parseMatchPage", () => {
  it("lit athlètes A/B, UUID, NOC, score final, vainqueur, méthode, stade, catégorie et n° de contest", () => {
    const result = parseMatchPage(matchPageHtml(), MATCH_1_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { match, anomalies } = result;

    expect(match.sourceMatchId).toBe(MATCH_1_ID);
    expect(match.competitionName).toBe("Exemple 2026 World Taekwondo Grand Prix");
    expect(match.contestNumber).toBe(140);
    expect(match.bracketStage).toBe("F");
    expect(match.categoryLabel).toBe("Women -49kg");
    expect(match.athleteA).toEqual({
      sourceId: ALICE.id,
      name: ALICE.name,
      countryCode: "FRA",
      imageUrl: `https://results.worldtaekwondo.org/storage/photos/w225/${ALICE.id}.jpg`,
    });
    expect(match.athleteB.sourceId).toBe(BRUNO.id);
    expect(match.athleteB.countryCode).toBe("KOR");
    expect(match.scoreA).toBe(2);
    expect(match.scoreB).toBe(1);
    expect(match.winner).toBe("A");
    expect(match.resultMethod).toBe("PTF");
    expect(match.resultMethodRaw).toBe("Won by PTF");
    expect(anomalies).toEqual([]);
  });

  it("orientation : le vainqueur peut être l'athlète B (score 0-2) — l'ordre A/B et les scores suivent la page, pas le résumé", () => {
    const result = parseMatchPage(matchPageHtml({ scoreA: "0", scoreB: "2", winner: "B" }), MATCH_1_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.match.athleteA.sourceId).toBe(ALICE.id);
    expect(result.match.scoreA).toBe(0);
    expect(result.match.scoreB).toBe(2);
    expect(result.match.winner).toBe("B");
  });

  it("le vainqueur vient du marqueur de la source, JAMAIS de scoreA > scoreB (RSC : le vainqueur peut avoir le score le plus bas)", () => {
    const result = parseMatchPage(
      matchPageHtml({ scoreA: "0", scoreB: "1", winner: "A", methodText: "Won by RSC" }),
      MATCH_1_ID,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.match.winner).toBe("A");
    expect(result.match.resultMethod).toBe("RSC");
    // Pas d'anomalie PTF : la méthode n'est pas PTF.
    expect(result.anomalies).toEqual([]);
  });

  it.each([
    ["WDR", "Won by WDR"],
    ["DSQ", "Won by DSQ"],
    ["DQB", "Won by DQB"],
  ])("conserve la méthode source %s", (code, text) => {
    const result = parseMatchPage(matchPageHtml({ methodText: text }), MATCH_1_ID);
    expect(result.ok && result.match.resultMethod).toBe(code);
  });

  it("la méthode est lue dans la colonne du VAINQUEUR : B gagne ⇒ 'Won by PTF' en 3ᵉ cellule (cas réel), A gagne ⇒ 1ʳᵉ cellule", () => {
    const b = parseMatchPage(matchPageHtml({ scoreA: "0", scoreB: "2", winner: "B", methodText: "Won by WDR" }), MATCH_1_ID);
    expect(b.ok && b.match.resultMethod).toBe("WDR");
    expect(b.ok && b.match.resultMethodRaw).toBe("Won by WDR");
    expect(b.ok && b.anomalies).toEqual([]);

    const a = parseMatchPage(matchPageHtml({ winner: "A", methodText: "Won by RSC" }), MATCH_1_ID);
    expect(a.ok && a.match.resultMethod).toBe("RSC");
    expect(a.ok && a.anomalies).toEqual([]);
  });

  it("méthode affichée du côté du perdant ⇒ conservée + anomalie (jamais corrigée)", () => {
    const html = matchPageHtml({ winner: "B", scoreA: "0", scoreB: "2" }).replace(
      /<tr class="match-detail-won">.*?<\/tr>/,
      '<tr class="match-detail-won"><th>Won by PTF</th><th></th><th></th></tr>',
    );
    const result = parseMatchPage(html, MATCH_1_ID);
    expect(result.ok && result.match.resultMethod).toBe("PTF");
    expect(result.ok && result.anomalies.join(" ")).toMatch(/côté A alors que le vainqueur marqué est B/);
  });

  it("plusieurs cellules de méthode renseignées ⇒ première conservée + anomalie", () => {
    const html = matchPageHtml().replace(/<tr class="match-detail-won">.*?<\/tr>/, '<tr class="match-detail-won"><th>Won by PTF</th><th></th><th>Won by RSC</th></tr>');
    const result = parseMatchPage(html, MATCH_1_ID);
    expect(result.ok && result.match.resultMethod).toBe("PTF");
    expect(result.ok && result.anomalies.join(" ")).toMatch(/plusieurs cellules/);
  });

  it("victoire aux points dont le score vainqueur n'est pas supérieur ⇒ conservée + anomalie rapportée (jamais corrigée)", () => {
    const result = parseMatchPage(matchPageHtml({ scoreA: "1", scoreB: "2", winner: "A" }), MATCH_1_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.match.winner).toBe("A");
    expect(result.match.scoreA).toBe(1);
    expect(result.match.scoreB).toBe(2);
    expect(result.anomalies.join(" ")).toMatch(/PTF/);
  });

  it("aucun vainqueur exposé ⇒ winner null (jamais déduit) + anomalie", () => {
    const result = parseMatchPage(matchPageHtml({ winner: null }), MATCH_1_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.match.winner).toBeNull();
    expect(result.anomalies.join(" ")).toMatch(/aucun vainqueur/);
  });

  it("deux vainqueurs marqués ⇒ winner null + anomalie", () => {
    const result = parseMatchPage(matchPageHtml({ winner: "both" }), MATCH_1_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.match.winner).toBeNull();
    expect(result.anomalies.join(" ")).toMatch(/deux athlètes/);
  });

  it("données absentes tolérées : score vide, méthode vide, titre sans stade ni catégorie, photo absente", () => {
    const html = matchPageHtml({ scoreA: "", scoreB: "", winner: null, methodText: "", stage: null, category: null, contestNumber: null });
    const result = parseMatchPage(html, MATCH_1_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.match.scoreA).toBeNull();
    expect(result.match.scoreB).toBeNull();
    expect(result.match.resultMethod).toBeNull();
    expect(result.match.resultMethodRaw).toBeNull();
    expect(result.match.bracketStage).toBeNull();
    expect(result.match.categoryLabel).toBeNull();
    expect(result.match.contestNumber).toBeNull();
  });

  describe("athlètes sans photo (cas réel : placeholder sans alt)", () => {
    it("placeholder 'SURNAME Given' confirme l'en-tête 'Given SURNAME' (ordre des mots ignoré) ; jamais stocké comme photo", () => {
      const result = parseMatchPage(matchPageHtml({ photoB: "placeholder" }), MATCH_1_ID);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.match.athleteB.sourceId).toBe(BRUNO.id);
      expect(result.match.athleteB.imageUrl).toBeNull();
      expect(result.match.athleteA.imageUrl).toContain("/storage/photos/");
    });

    it("les deux athlètes sans photo ⇒ confirmés par leurs placeholders, imageUrl null des deux côtés", () => {
      const result = parseMatchPage(matchPageHtml({ photoA: "placeholder", photoB: "placeholder" }), MATCH_1_ID);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect([result.match.athleteA.imageUrl, result.match.athleteB.imageUrl]).toEqual([null, null]);
    });

    it("un seul côté confirmé par son nom (l'autre sans aucun signal) ⇒ accepté, orientation fixée par le côté confirmé", () => {
      const result = parseMatchPage(matchPageHtml({ photoA: "photo", photoB: "none" }), MATCH_1_ID);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.match.athleteA.sourceId).toBe(ALICE.id);
      expect(result.match.athleteB.sourceId).toBe(BRUNO.id);
      expect(result.match.athleteB.imageUrl).toBeNull();
    });

    it("placeholder dont le texte contredit l'en-tête ⇒ refus", () => {
      const html = matchPageHtml({ photoB: "placeholder" }).replace("text=TESTEUR Bruno", "text=AUTRE Personne");
      expect(parseMatchPage(html, MATCH_1_ID).ok).toBe(false);
    });

    it("noms accentués / ponctués comparés sans accents ni ponctuation", () => {
      const accented = { ...BRUNO, name: "José MUÑOZ-DÍAZ" };
      const result = parseMatchPage(matchPageHtml({ b: accented, photoB: "placeholder" }).replace("MUÑOZ-DÍAZ José", "MUNOZ DIAZ Jose"), MATCH_1_ID);
      expect(result.ok).toBe(true);
    });
  });

  it("NOC absent ⇒ null + anomalie, le match reste importable", () => {
    const result = parseMatchPage(matchPageHtml({ a: { ...ALICE, noc: "" } }), MATCH_1_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.match.athleteA.countryCode).toBeNull();
    expect(result.anomalies.join(" ")).toMatch(/NOC/);
  });

  it("supporte un code NOC non standard à 3 lettres (AIN)", () => {
    const result = parseMatchPage(matchPageHtml({ b: { ...BRUNO, noc: "AIN" } }), MATCH_1_ID);
    expect(result.ok && result.match.athleteB.countryCode).toBe("AIN");
  });

  describe("pages malformées ⇒ refus explicite, jamais une devinette", () => {
    it("page vide / non-match", () => {
      const result = parseMatchPage("<html><body><p>Not found</p></body></html>", MATCH_1_ID);
      expect(result.ok).toBe(false);
    });

    it("bloc participants absent", () => {
      const result = parseMatchPage(matchPageHtml({ omitParticipants: true }), MATCH_1_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/participants/);
    });

    it("orientation non vérifiable : le nom du lien profil CONTREDIT l'en-tête", () => {
      const result = parseMatchPage(matchPageHtml({ linkAltA: "Quelqu'un D'AUTRE" }), MATCH_1_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/contredit/);
    });

    it("contradiction sur un seul côté même si l'autre est confirmé ⇒ refus", () => {
      const result = parseMatchPage(matchPageHtml({ linkAltB: "Quelqu'un D'AUTRE" }), MATCH_1_ID);
      expect(result.ok).toBe(false);
    });

    it("aucun côté confirmable (photos sans alt des deux côtés) ⇒ refus", () => {
      const result = parseMatchPage(matchPageHtml({ photoA: "photo-no-alt", photoB: "none" }), MATCH_1_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/aucun nom de confirmation/);
    });

    it("les deux liens profil désignent le même UUID", () => {
      const result = parseMatchPage(matchPageHtml({ profileLinkIds: [ALICE.id, ALICE.id] }), MATCH_1_ID);
      expect(result.ok).toBe(false);
    });

    it("UUID de lien profil invalide", () => {
      const result = parseMatchPage(matchPageHtml({ profileLinkIds: ["not-a-uuid", BRUNO.id] }), MATCH_1_ID);
      expect(result.ok).toBe(false);
    });

    it("identifiant de match invalide", () => {
      expect(parseMatchPage(matchPageHtml(), "abc").ok).toBe(false);
    });
  });
});

describe("parseProfilePage", () => {
  it("lit UUID, nom, NOC, photo et record V/D affiché", () => {
    const result = parseProfilePage(profilePageHtml(), ALICE.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile).toEqual({
      sourceId: ALICE.id,
      displayName: ALICE.name,
      countryCode: "FRA",
      imageUrl: `https://results.worldtaekwondo.org/storage/photos/w225/${ALICE.id}.jpg`,
      recordWins: 53,
      recordLosses: 13,
    });
    expect(result.anomalies).toEqual([]);
  });

  it("photo de profil = placeholder tiers ⇒ imageUrl null (jamais une fausse photo)", () => {
    const html = profilePageHtml().replace(/https:\/\/results\.worldtaekwondo\.org\/storage\/photos\/w225\/[^"]+\.jpg/, "https://placehold.co/225x275?text=EXEMPLE Alice");
    const result = parseProfilePage(html, ALICE.id);
    expect(result.ok && result.profile.imageUrl).toBeNull();
  });

  it("ne confond pas le menu déroulant des athlètes avec le profil", () => {
    const result = parseProfilePage(profilePageHtml({ athlete: CHLOE }), CHLOE.id);
    expect(result.ok && result.profile.displayName).toBe("Chloe SAMPLE");
  });

  it("record absent ⇒ null/null (pas de faux 0-0)", () => {
    const result = parseProfilePage(profilePageHtml({ record: null }), ALICE.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.recordWins).toBeNull();
    expect(result.profile.recordLosses).toBeNull();
  });

  it('record "-" ⇒ null/null sans anomalie ; record illisible ⇒ null/null + anomalie', () => {
    const dash = parseProfilePage(profilePageHtml({ record: "-" }), ALICE.id);
    expect(dash.ok && dash.profile.recordWins).toBeNull();
    expect(dash.ok && dash.anomalies).toEqual([]);

    const weird = parseProfilePage(profilePageHtml({ record: "n/a" }), ALICE.id);
    expect(weird.ok && weird.profile.recordWins).toBeNull();
    expect(weird.ok && weird.anomalies.join(" ")).toMatch(/record/);
  });

  it("NOC invalide ⇒ null + anomalie", () => {
    const result = parseProfilePage(profilePageHtml({ noc: "??" }), ALICE.id);
    expect(result.ok && result.profile.countryCode).toBeNull();
    expect(result.ok && result.anomalies.join(" ")).toMatch(/NOC/);
  });

  it("page non profil ⇒ refus", () => {
    expect(parseProfilePage("<html><body>404</body></html>", ALICE.id).ok).toBe(false);
  });

  it("UUID invalide ⇒ refus", () => {
    expect(parseProfilePage(profilePageHtml(), "nope").ok).toBe(false);
  });
});

describe("parseResultsListing", () => {
  it("extrait les catégories (event UUID) et les identifiants de match uniques, dans l'ordre", () => {
    const html = resultsListHtml({ matchIds: [MATCH_1_ID, MATCH_2_ID, MATCH_1_ID] });
    const listing = parseResultsListing(html);
    expect(listing.matchIds).toEqual([MATCH_1_ID, MATCH_2_ID]);
    expect(listing.categories).toEqual([{ label: "Men -68kg", eventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }]);
  });

  it("page sans résultat ⇒ listes vides", () => {
    expect(parseResultsListing("<html></html>")).toEqual({ categories: [], matchIds: [] });
  });
});

describe("parseCompetitionList", () => {
  it("lit slug, nom (texte de la cellule, pas le commentaire HTML), dates ; ignore les lignes sans lien Results", () => {
    const html = competitionListHtml([
      { slug: "roma-2026-world-taekwondo-grand-prix", name: "Roma 2026 World Taekwondo Grand-Prix", dateText: "5 - 7 Jun 2026" },
      { slug: "future-2026-open", name: "Future 2026 Open", dateText: "1 - 2 Dec 2026", withResults: false },
      { slug: "para-2026", name: "Para 2026", dateText: "4 Sep 2026" },
      { slug: "cross-2026", name: "Cross 2026", dateText: "30 Sep - 2 Oct 2026" },
    ]);
    const items = parseCompetitionList(html);
    expect(items.map((i) => i.slug)).toEqual(["roma-2026-world-taekwondo-grand-prix", "para-2026", "cross-2026"]);
    expect(items[0].name).toBe("Roma 2026 World Taekwondo Grand-Prix");
    expect(items[0].dateStart.toISOString()).toBe("2026-06-05T00:00:00.000Z");
    expect(items[0].dateEnd.toISOString()).toBe("2026-06-07T00:00:00.000Z");
    expect(items[1].dateEnd.toISOString()).toBe("2026-09-04T00:00:00.000Z");
    expect(items[2].dateEnd.toISOString()).toBe("2026-10-02T00:00:00.000Z");
  });

  it("date illisible ⇒ ligne ignorée (jamais devinée)", () => {
    const html = competitionListHtml([{ slug: "x-2026", name: "X 2026", dateText: "TBD" }]);
    expect(parseCompetitionList(html)).toEqual([]);
  });
});

describe("parseWtrDateRange", () => {
  it.each([
    ["4 Sep 2026", "2026-09-04", "2026-09-04"],
    ["5 - 7 Sep 2026", "2026-09-05", "2026-09-07"],
    ["1 Oct - 6 Oct 2014", "2014-10-01", "2014-10-06"],
    ["  12 - 17 Apr 2026 ", "2026-04-12", "2026-04-17"],
  ])("%s", (text, start, end) => {
    const range = parseWtrDateRange(text);
    expect(range?.start.toISOString().slice(0, 10)).toBe(start);
    expect(range?.end.toISOString().slice(0, 10)).toBe(end);
  });

  it.each(["", "TBD", "31 Feb 2026", "5 - 7 Foo 2026", "September 2026"])("rejette %j", (text) => {
    expect(parseWtrDateRange(text)).toBeNull();
  });
});

describe("URLs / provenance", () => {
  it("construit les URL source et la constante de source", () => {
    expect(WT_RESULTS_SOURCE).toBe("world_taekwondo_results");
    expect(competitionResultsUrl("roma-2026-world-taekwondo-grand-prix")).toBe(
      "https://results.worldtaekwondo.org/competitions/roma-2026-world-taekwondo-grand-prix/results",
    );
    expect(matchUrl("roma", MATCH_1_ID)).toBe(`https://results.worldtaekwondo.org/competitions/roma/results/${MATCH_1_ID}`);
    expect(profileUrl(ALICE.id)).toBe(`https://results.worldtaekwondo.org/profile/${ALICE.id}`);
  });
});
