import { NotFoundException } from "@nestjs/common";
import { AthleteWithSources, InternationalRepository, MatchWithRelations } from "./international.repository";
import {
  athleteResult,
  compareCategoryLabels,
  InternationalService,
  toAthleteFightView,
  toAthleteView,
  toMatchView,
  toRecordedStats,
  toResultFightView,
  winnerSide,
} from "./international.service";

const now = new Date("2026-09-19T10:00:00Z");

function athleteRow(overrides: Partial<AthleteWithSources> = {}): AthleteWithSources {
  return {
    id: "a1",
    display_name: "Alice EXEMPLE",
    country_code: "FRA",
    gender: null,
    birth_date: null,
    created_at: now,
    updated_at: now,
    sources: [
      {
        id: "s1",
        external_athlete_id: "a1",
        source: "world_taekwondo_results",
        source_external_id: "uuid-1",
        source_url: "https://results.worldtaekwondo.org/profile/uuid-1",
        raw_name: "Alice EXEMPLE",
        image_url: "https://results.worldtaekwondo.org/storage/photos/w225/uuid-1.jpg",
        record_wins: null,
        record_losses: null,
        record_synced_at: null,
        created_at: now,
        updated_at: now,
      },
    ],
    ...overrides,
  };
}

function matchRow(overrides: Partial<MatchWithRelations> = {}): MatchWithRelations {
  const a = athleteRow().id;
  const base = { gender: null, birth_date: null, created_at: now, updated_at: now };
  return {
    id: "m1",
    competition_id: "c1",
    source: "world_taekwondo_results",
    source_external_id: "match-uuid",
    source_url: "https://results.worldtaekwondo.org/competitions/x/results/match-uuid",
    occurred_at: null,
    category_label: "Women -49kg",
    bracket_stage: "F",
    contest_number: 140,
    athlete_a_id: a,
    athlete_b_id: "a2",
    score_a: 2,
    score_b: 1,
    winner_athlete_id: a,
    result_method: "PTF",
    result_method_raw: "Won by PTF",
    created_at: now,
    updated_at: now,
    athlete_a: { id: a, display_name: "Alice EXEMPLE", country_code: "FRA", ...base },
    athlete_b: { id: "a2", display_name: "Bruno TESTEUR", country_code: "KOR", ...base },
    winner: { id: a, display_name: "Alice EXEMPLE", country_code: "FRA", ...base },
    competition: { id: "c1", nom: "Exemple 2026", date_debut: now, date_fin: null, lieu: null, ville: "Paris", pays: "France" },
    sources: [
      {
        id: "ms1",
        competition_match_id: "m1",
        source: "world_taekwondo_results",
        source_external_id: "match-uuid",
        source_url: "https://results.worldtaekwondo.org/competitions/x/results/match-uuid",
        created_at: now,
      },
    ],
    ...overrides,
  };
}

describe("toAthleteView", () => {
  it("expose id, nom, NOC tel quel, photo source, provenance ; jamais les champs internes", () => {
    const view = toAthleteView(athleteRow());
    expect(view).toEqual({
      id: "a1",
      displayName: "Alice EXEMPLE",
      countryCode: "FRA",
      imageUrl: "https://results.worldtaekwondo.org/storage/photos/w225/uuid-1.jpg",
      sources: [{ source: "world_taekwondo_results", externalId: "uuid-1", sourceUrl: "https://results.worldtaekwondo.org/profile/uuid-1" }],
      stats: { sourceRecord: null },
    });
    expect(JSON.stringify(view)).not.toMatch(/created_at|updated_at|raw_name/);
  });

  it("aucun record relevé ⇒ sourceRecord null (jamais un record recalculé sur nos matchs partiels)", () => {
    expect(toAthleteView(athleteRow()).stats.sourceRecord).toBeNull();
  });

  it("record relevé ⇒ exposé AVEC provenance et date de relevé, et 0 victoire reste 0 (pas confondu avec absent)", () => {
    const row = athleteRow();
    row.sources[0].record_wins = 0;
    row.sources[0].record_losses = 3;
    row.sources[0].record_synced_at = now;
    expect(toAthleteView(row).stats.sourceRecord).toEqual({
      wins: 0,
      losses: 3,
      source: "world_taekwondo_results",
      syncedAt: now,
    });
  });

  it("photo absente ⇒ imageUrl null", () => {
    const row = athleteRow();
    row.sources[0].image_url = null;
    expect(toAthleteView(row).imageUrl).toBeNull();
  });
});

describe("toMatchView", () => {
  it("conserve l'orientation A/B, les scores, le stade (pas 'round'), la catégorie, la méthode et la provenance", () => {
    expect(toMatchView(matchRow())).toEqual({
      id: "m1",
      competition: { id: "c1", name: "Exemple 2026", dateDebut: now, dateFin: null, lieu: null, ville: "Paris", pays: "France" },
      category: "Women -49kg",
      stage: "F",
      contestNumber: 140,
      athleteA: { id: "a1", displayName: "Alice EXEMPLE", countryCode: "FRA" },
      athleteB: { id: "a2", displayName: "Bruno TESTEUR", countryCode: "KOR" },
      scoreA: 2,
      scoreB: 1,
      winner: { id: "a1", displayName: "Alice EXEMPLE", countryCode: "FRA" },
      method: "PTF",
      source: {
        source: "world_taekwondo_results",
        externalId: "match-uuid",
        sourceUrl: "https://results.worldtaekwondo.org/competitions/x/results/match-uuid",
      },
      sources: [
        {
          source: "world_taekwondo_results",
          externalId: "match-uuid",
          sourceUrl: "https://results.worldtaekwondo.org/competitions/x/results/match-uuid",
        },
      ],
    });
  });

  it("un combat publié sous plusieurs identifiants source les expose TOUS dans sources (un seul combat, provenance complète)", () => {
    const rep = (n: number) => ({
      id: `ms${n}`,
      competition_match_id: "m1",
      source: "world_taekwondo_results",
      source_external_id: `copie-${n}`,
      source_url: `https://results.worldtaekwondo.org/competitions/x/results/copie-${n}`,
      created_at: now,
    });

    const view = toMatchView(matchRow({ sources: [rep(1), rep(2), rep(3), rep(4)] }));

    expect(view.sources.map((s) => s.externalId)).toEqual(["copie-1", "copie-2", "copie-3", "copie-4"]);
  });

  it("vainqueur, scores et méthode absents ⇒ null (jamais fabriqués) ; score 0 conservé", () => {
    const view = toMatchView(matchRow({ winner: null, winner_athlete_id: null, score_a: 0, score_b: null, result_method: null }));
    expect(view.winner).toBeNull();
    expect(view.scoreA).toBe(0);
    expect(view.scoreB).toBeNull();
    expect(view.method).toBeNull();
  });
});

describe("InternationalService", () => {
  let repository: jest.Mocked<
    Pick<
      InternationalRepository,
      | "findAthleteById"
      | "findMatchesByAthlete"
      | "findMatchesByCompetition"
      | "competitionExists"
      | "searchAthletes"
      | "countAthleteFights"
      | "findAthleteCompetitionHistory"
      | "summarizeCompetitionResults"
      | "findCompetitionCategoryMatches"
    >
  >;
  let service: InternationalService;

  beforeEach(() => {
    repository = {
      findAthleteById: jest.fn(),
      findMatchesByAthlete: jest.fn(),
      findMatchesByCompetition: jest.fn(),
      competitionExists: jest.fn(),
      searchAthletes: jest.fn(),
      countAthleteFights: jest.fn(),
      findAthleteCompetitionHistory: jest.fn(),
      summarizeCompetitionResults: jest.fn(),
      findCompetitionCategoryMatches: jest.fn(),
    };
    service = new InternationalService(repository as unknown as InternationalRepository);
  });

  it("getAthlete : 404 si inconnu", async () => {
    repository.findAthleteById.mockResolvedValue(null);
    await expect(service.getAthlete("x")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("getAthleteMatches : 404 si l'athlète est inconnu, sans requêter les matchs", async () => {
    repository.findAthleteById.mockResolvedValue(null);
    await expect(service.getAthleteMatches("x", 1, 20)).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findMatchesByAthlete).not.toHaveBeenCalled();
  });

  it("getAthleteMatches : renvoie la page mappée (items, total, page, limit)", async () => {
    repository.findAthleteById.mockResolvedValue(athleteRow());
    repository.findMatchesByAthlete.mockResolvedValue({ items: [matchRow()], total: 41, page: 2, limit: 20 });
    const result = await service.getAthleteMatches("a1", 2, 20);
    expect(result).toMatchObject({ total: 41, page: 2, limit: 20 });
    expect(result.items[0].stage).toBe("F");
  });

  it("getCompetitionMatches : 404 si la competition est inconnue ; sinon page mappée", async () => {
    repository.competitionExists.mockResolvedValueOnce(false);
    await expect(service.getCompetitionMatches("c", 1, 20)).rejects.toBeInstanceOf(NotFoundException);

    repository.competitionExists.mockResolvedValueOnce(true);
    repository.findMatchesByCompetition.mockResolvedValue({ items: [matchRow()], total: 1, page: 1, limit: 20 });
    const result = await service.getCompetitionMatches("c1", 1, 20);
    expect(result.items).toHaveLength(1);
  });

  it("searchAthletes : identité publique + provenance + nombre de combats logiques (a + b), jamais l'objet Prisma brut", async () => {
    repository.searchAthletes.mockResolvedValue({
      items: [
        {
          id: "a1",
          display_name: "Alice EXEMPLE",
          country_code: "FRA",
          sources: [{ source: "world_taekwondo_results", source_external_id: "uuid-1", source_url: "https://x/uuid-1" }],
          _count: { matches_as_a: 3, matches_as_b: 2 },
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });
    const result = await service.searchAthletes("alice", 1, 20);
    expect(repository.searchAthletes).toHaveBeenCalledWith("alice", 1, 20, "name");
    expect(result).toEqual({
      items: [
        {
          id: "a1",
          displayName: "Alice EXEMPLE",
          countryCode: "FRA",
          sources: [{ source: "world_taekwondo_results", externalId: "uuid-1", sourceUrl: "https://x/uuid-1" }],
          fightCount: 5,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });
  });

  it("getAthlete : ajoute stats.recorded (combats recensés) sans toucher stats.sourceRecord", async () => {
    repository.findAthleteById.mockResolvedValue(athleteRow());
    repository.countAthleteFights.mockResolvedValue({ fights: 5, wins: 3, losses: 1, unknown: 1, competitions: 2 });
    const view = await service.getAthlete("a1");
    expect(view.stats.sourceRecord).toBeNull();
    expect(view.stats.recorded).toEqual({ fights: 5, wins: 3, losses: 1, unknown: 1, competitions: 2, winRate: 75 });
  });

  it("getAthleteMatches : chaque combat porte la perspective de l'athlète demandé (côté B ⇒ adversaire = A)", async () => {
    repository.findAthleteById.mockResolvedValue(athleteRow({ id: "a2" }));
    repository.findMatchesByAthlete.mockResolvedValue({ items: [matchRow()], total: 1, page: 1, limit: 20 });
    const result = await service.getAthleteMatches("a2", 1, 20);
    expect(result.items[0].athleteA.id).toBe("a1");
    expect(result.items[0].perspective).toMatchObject({ side: "B", opponent: { id: "a1" }, result: { outcome: "LOSS", athleteScore: 1, opponentScore: 2 } });
  });

  it("getAthleteCompetitions : 404 si l'athlète est inconnu, sans requêter l'historique", async () => {
    repository.findAthleteById.mockResolvedValue(null);
    await expect(service.getAthleteCompetitions("x", 1, 10)).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findAthleteCompetitionHistory).not.toHaveBeenCalled();
  });

  it("getAthleteCompetitions : groupe par compétition, compte V/D/inconnu, ordonne les combats R32 → F, catégories réelles", async () => {
    const c2 = { id: "c2", nom: "Autre 2025", date_debut: now, date_fin: null, lieu: null, ville: null, pays: null };
    repository.findAthleteById.mockResolvedValue(athleteRow());
    repository.findAthleteCompetitionHistory.mockResolvedValue({
      competitions: [matchRow().competition, c2],
      matches: [
        matchRow({ id: "final", bracket_stage: "F", contest_number: 900 }),
        matchRow({ id: "r32", bracket_stage: "R32", contest_number: 100, winner_athlete_id: "a1" }),
        matchRow({ id: "sf", bracket_stage: "SF", contest_number: 500, winner_athlete_id: "a2" }),
        matchRow({ id: "other", competition_id: "c2", bracket_stage: null, winner_athlete_id: null, category_label: "Women -53kg" }),
      ],
      total: 7,
      page: 1,
      limit: 2,
    });
    const result = await service.getAthleteCompetitions("a1", 1, 2);
    expect(result).toMatchObject({ total: 7, page: 1, limit: 2 });
    expect(result.items.map((i) => i.competition.id)).toEqual(["c1", "c2"]);
    expect(result.items[0]).toMatchObject({ fights: 3, wins: 2, losses: 1, unknown: 0, categories: ["Women -49kg"] });
    expect(result.items[0].matches.map((m) => m.id)).toEqual(["r32", "sf", "final"]);
    expect(result.items[1]).toMatchObject({ fights: 1, wins: 0, losses: 0, unknown: 1, categories: ["Women -53kg"] });
    expect(result.items[0].competition).toEqual({ id: "c1", name: "Exemple 2026", dateDebut: now, dateFin: null, lieu: null, ville: "Paris", pays: "France" });
  });
});

describe("InternationalService — résultats d'événement", () => {
  let repository: jest.Mocked<Pick<InternationalRepository, "competitionExists" | "summarizeCompetitionResults" | "findCompetitionCategoryMatches">>;
  let service: InternationalService;

  beforeEach(() => {
    repository = { competitionExists: jest.fn(), summarizeCompetitionResults: jest.fn(), findCompetitionCategoryMatches: jest.fn() };
    service = new InternationalService(repository as unknown as InternationalRepository);
  });

  it("competition inconnue ⇒ 404, sans requêter les résultats", async () => {
    repository.competitionExists.mockResolvedValue(false);
    await expect(service.getCompetitionResultsSummary("c")).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.summarizeCompetitionResults).not.toHaveBeenCalled();
  });

  it("résumé : totaux + catégories dans l'ordre sportif déterministe, jamais la liste des combats", async () => {
    repository.competitionExists.mockResolvedValue(true);
    repository.summarizeCompetitionResults.mockResolvedValue({
      fights: 10,
      athletes: 12,
      categories: [
        { category_label: "Women -49kg", fights: 2, athletes: 3 },
        { category_label: ".1 (QF) / Men -80kg", fights: 1, athletes: 2 },
        { category_label: "Men +80kg", fights: 3, athletes: 4 },
        { category_label: "Men -80kg", fights: 2, athletes: 3 },
        { category_label: "Men -58kg", fights: 2, athletes: 3 },
      ],
    });
    const result = await service.getCompetitionResultsSummary("c1");
    expect(result).toEqual({
      competitionId: "c1",
      matchCount: 10,
      athleteCount: 12,
      categories: [
        { label: "Men -58kg", fightCount: 2, athleteCount: 3 },
        { label: "Men -80kg", fightCount: 2, athleteCount: 3 },
        { label: "Men +80kg", fightCount: 3, athleteCount: 4 },
        { label: "Women -49kg", fightCount: 2, athleteCount: 3 },
        { label: ".1 (QF) / Men -80kg", fightCount: 1, athleteCount: 2 },
      ],
    });
    expect(repository.findCompetitionCategoryMatches).not.toHaveBeenCalled();
  });

  it("catégorie : combats groupés par tour dans l'ordre du tableau (R32 → F), tour inconnu en dernier", async () => {
    repository.competitionExists.mockResolvedValue(true);
    repository.findCompetitionCategoryMatches.mockResolvedValue([
      matchRow({ id: "f", bracket_stage: "F", contest_number: 900 }),
      matchRow({ id: "qf2", bracket_stage: "QF", contest_number: 402 }),
      matchRow({ id: "x", bracket_stage: null, contest_number: 1 }),
      matchRow({ id: "qf1", bracket_stage: "QF", contest_number: 401 }),
      matchRow({ id: "r32", bracket_stage: "R32", contest_number: 101 }),
    ]);
    const result = await service.getCompetitionCategoryResults("c1", "Women -49kg");
    expect(repository.findCompetitionCategoryMatches).toHaveBeenCalledWith("c1", "Women -49kg");
    expect(result.fightCount).toBe(5);
    expect(result.rounds.map((r) => [r.stage, r.fights.map((f) => f.id)])).toEqual([
      ["R32", ["r32"]],
      ["QF", ["qf1", "qf2"]],
      ["F", ["f"]],
      [null, ["x"]],
    ]);
  });

  it("catégorie absente de la compétition ⇒ 404", async () => {
    repository.competitionExists.mockResolvedValue(true);
    repository.findCompetitionCategoryMatches.mockResolvedValue([]);
    await expect(service.getCompetitionCategoryResults("c1", "Men -99kg")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("winnerSide / toResultFightView", () => {
  it("vainqueur = A ⇒ A ; = B ⇒ B ; absent ou étranger au combat ⇒ null (jamais déduit des scores)", () => {
    const fight = { athlete_a_id: "a1", athlete_b_id: "a2" };
    expect(winnerSide({ ...fight, winner_athlete_id: "a1" })).toBe("A");
    expect(winnerSide({ ...fight, winner_athlete_id: "a2" })).toBe("B");
    expect(winnerSide({ ...fight, winner_athlete_id: null })).toBeNull();
    expect(winnerSide({ ...fight, winner_athlete_id: "zz" })).toBeNull();
  });

  it("vue combat : A/B dans l'ordre publié, scores stockés, méthode, provenance complète ; vainqueur au score inférieur conservé", () => {
    const rep = (n: number) => ({ id: `ms${n}`, competition_match_id: "m1", source: "world_taekwondo_results", source_external_id: `copie-${n}`, source_url: null, created_at: now });
    const view = toResultFightView(matchRow({ score_a: 0, score_b: 2, winner_athlete_id: "a1", result_method: "RSC", sources: [rep(1), rep(2), rep(3)] }));
    expect(view).toEqual({
      id: "m1",
      category: "Women -49kg",
      stage: "F",
      contestNumber: 140,
      athleteA: { id: "a1", displayName: "Alice EXEMPLE", countryCode: "FRA" },
      athleteB: { id: "a2", displayName: "Bruno TESTEUR", countryCode: "KOR" },
      scoreA: 0,
      scoreB: 2,
      winnerSide: "A",
      method: "RSC",
      sources: [1, 2, 3].map((n) => ({ source: "world_taekwondo_results", externalId: `copie-${n}`, sourceUrl: null })),
    });
  });
});

describe("compareCategoryLabels", () => {
  it("préfixe puis poids croissant, - avant + au même poids ; labels non structurés ensuite (alphabétique) ; casse jamais fusionnée", () => {
    const labels = ["Women +67kg", "MEN -58kg", "Men -58kg", ".2 (QF) / Men -80kg", "Men +80kg", "Men -80kg", "Women -49kg", "Open"];
    expect([...labels].sort(compareCategoryLabels)).toEqual([
      "MEN -58kg",
      "Men -58kg",
      "Men -80kg",
      "Men +80kg",
      "Women -49kg",
      "Women +67kg",
      ".2 (QF) / Men -80kg",
      "Open",
    ]);
  });
});

describe("athleteResult — interprétation unique du résultat", () => {
  const fight = { athlete_a_id: "a1", athlete_b_id: "a2" };

  it("vainqueur = l'athlète ⇒ WIN, quel que soit son côté", () => {
    expect(athleteResult({ ...fight, winner_athlete_id: "a1" }, "a1")).toBe("WIN");
    expect(athleteResult({ ...fight, winner_athlete_id: "a2" }, "a2")).toBe("WIN");
  });

  it("vainqueur = l'adversaire ⇒ LOSS", () => {
    expect(athleteResult({ ...fight, winner_athlete_id: "a2" }, "a1")).toBe("LOSS");
  });

  it("aucun vainqueur ⇒ UNKNOWN (jamais déduit des scores)", () => {
    expect(athleteResult({ ...fight, winner_athlete_id: null }, "a1")).toBe("UNKNOWN");
  });

  it("fail-safe : athlète étranger au combat ou vainqueur étranger au combat ⇒ UNKNOWN", () => {
    expect(athleteResult({ ...fight, winner_athlete_id: "a1" }, "zz")).toBe("UNKNOWN");
    expect(athleteResult({ ...fight, winner_athlete_id: "zz" }, "a1")).toBe("UNKNOWN");
  });
});

describe("toAthleteFightView", () => {
  it("côté A : scores dans l'ordre publié, adversaire = B", () => {
    const view = toAthleteFightView(matchRow(), "a1");
    expect(view).toMatchObject({
      id: "m1",
      competitionId: "c1",
      side: "A",
      stage: "F",
      category: "Women -49kg",
      opponent: { id: "a2", displayName: "Bruno TESTEUR", countryCode: "KOR" },
      result: { outcome: "WIN", athleteScore: 2, opponentScore: 1, method: "PTF" },
    });
  });

  it("côté B : scores réorientés vers l'athlète, jamais modifiés ; adversaire = A", () => {
    const view = toAthleteFightView(matchRow(), "a2");
    expect(view.side).toBe("B");
    expect(view.opponent.id).toBe("a1");
    expect(view.result).toEqual({ outcome: "LOSS", athleteScore: 1, opponentScore: 2, method: "PTF" });
  });

  it("vainqueur au score INFÉRIEUR (RSC/WDR publiés ainsi) : le vainqueur fait foi, le score n'est pas corrigé", () => {
    const view = toAthleteFightView(matchRow({ score_a: 0, score_b: 2, winner_athlete_id: "a1", result_method: "RSC" }), "a1");
    expect(view.result).toEqual({ outcome: "WIN", athleteScore: 0, opponentScore: 2, method: "RSC" });
  });

  it("scores/méthode absents ⇒ null ; score 0 conservé", () => {
    const view = toAthleteFightView(matchRow({ score_a: 0, score_b: null, result_method: null }), "a1");
    expect(view.result).toMatchObject({ athleteScore: 0, opponentScore: null, method: null });
  });

  it("plusieurs représentations source ⇒ UN combat, toutes les sources listées", () => {
    const rep = (n: number) => ({ id: `ms${n}`, competition_match_id: "m1", source: "world_taekwondo_results", source_external_id: `copie-${n}`, source_url: null, created_at: now });
    const view = toAthleteFightView(matchRow({ sources: [rep(1), rep(2)] }), "a1");
    expect(view.id).toBe("m1");
    expect(view.sources.map((s) => s.externalId)).toEqual(["copie-1", "copie-2"]);
  });
});

describe("toRecordedStats", () => {
  it("winRate = victoires / combats décidés (inconnus exclus), arrondi entier", () => {
    expect(toRecordedStats({ fights: 4, wins: 2, losses: 1, unknown: 1, competitions: 1 }).winRate).toBe(67);
  });

  it("aucun combat décidé ⇒ winRate null (jamais 0 % inventé) ; 0 victoire sur combats décidés ⇒ 0", () => {
    expect(toRecordedStats({ fights: 0, wins: 0, losses: 0, unknown: 0, competitions: 0 }).winRate).toBeNull();
    expect(toRecordedStats({ fights: 1, wins: 0, losses: 0, unknown: 1, competitions: 1 }).winRate).toBeNull();
    expect(toRecordedStats({ fights: 2, wins: 0, losses: 2, unknown: 0, competitions: 1 }).winRate).toBe(0);
  });
});
