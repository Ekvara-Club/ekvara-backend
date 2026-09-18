import { NotFoundException } from "@nestjs/common";
import { AthleteWithSources, InternationalRepository, MatchWithRelations } from "./international.repository";
import { InternationalService, toAthleteView, toMatchView } from "./international.service";

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
    competition: { id: "c1", nom: "Exemple 2026", date_debut: now, date_fin: null },
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
      competition: { id: "c1", name: "Exemple 2026", dateDebut: now, dateFin: null },
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
    });
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
  let repository: jest.Mocked<Pick<InternationalRepository, "findAthleteById" | "findMatchesByAthlete" | "findMatchesByCompetition" | "competitionExists">>;
  let service: InternationalService;

  beforeEach(() => {
    repository = {
      findAthleteById: jest.fn(),
      findMatchesByAthlete: jest.fn(),
      findMatchesByCompetition: jest.fn(),
      competitionExists: jest.fn(),
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
});
