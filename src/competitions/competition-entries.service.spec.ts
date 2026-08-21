import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { CompetitionEntriesService } from "./competition-entries.service";
import { CompetitionsRepository } from "./competitions.repository";
import { CompetitionEntriesRepository } from "./competition-entries.repository";

describe("CompetitionEntriesService", () => {
  let service: CompetitionEntriesService;
  let competitionsRepository: { findById: jest.Mock };
  let entriesRepository: { findByCompetition: jest.Mock };

  const COMPETITION_ID = "d337932f-359b-4f5b-bab7-84a6f7cb8c94";

  function entry(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "entry-1",
      competition_id: COMPETITION_ID,
      source: "martial_events",
      source_category_raw_label: "Seniors Masculins -74 kg",
      age_category: "Senior",
      gender: "male",
      weight_category: "-74 kg",
      participant_name: "Dupont Jean",
      club: "TKD Paris",
      league: "IDF",
      country: "France",
      created_at: new Date(),
      updated_at: new Date(),
      ...overrides,
    };
  }

  beforeEach(async () => {
    competitionsRepository = { findById: jest.fn() };
    entriesRepository = { findByCompetition: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompetitionEntriesService,
        { provide: CompetitionsRepository, useValue: competitionsRepository },
        { provide: CompetitionEntriesRepository, useValue: entriesRepository },
      ],
    }).compile();

    service = module.get<CompetitionEntriesService>(CompetitionEntriesService);
  });

  it("lève NotFoundException quand la compétition n'existe pas", async () => {
    competitionsRepository.findById.mockResolvedValue(null);

    await expect(service.findByCompetition(COMPETITION_ID)).rejects.toThrow(NotFoundException);
    expect(entriesRepository.findByCompetition).not.toHaveBeenCalled();
  });

  it("compétition existante sans aucune entry -> categories vide, totalEntries 0 (jamais 404)", async () => {
    competitionsRepository.findById.mockResolvedValue({ id: COMPETITION_ID });
    entriesRepository.findByCompetition.mockResolvedValue([]);

    const result = await service.findByCompetition(COMPETITION_ID);

    expect(result).toEqual({ competitionId: COMPETITION_ID, categories: [], totalEntries: 0 });
  });

  it("regroupe les entries par source_category_raw_label", async () => {
    competitionsRepository.findById.mockResolvedValue({ id: COMPETITION_ID });
    entriesRepository.findByCompetition.mockResolvedValue([
      entry({ id: "e1", participant_name: "Dupont Jean" }),
      entry({ id: "e2", participant_name: "Martin Léa" }),
      entry({
        id: "e3",
        source_category_raw_label: "Seniors Féminines -46 kg",
        age_category: "Senior",
        gender: "female",
        weight_category: "-46 kg",
        participant_name: "Bernard Alice",
      }),
    ]);

    const result = await service.findByCompetition(COMPETITION_ID);

    expect(result.categories).toHaveLength(2);
    expect(result.totalEntries).toBe(3);
    const masc = result.categories.find((c) => c.rawLabel === "Seniors Masculins -74 kg");
    expect(masc?.entries).toHaveLength(2);
  });

  it("ne renvoie jamais les champs internes Prisma (created_at, updated_at, competition_id, source)", async () => {
    competitionsRepository.findById.mockResolvedValue({ id: COMPETITION_ID });
    entriesRepository.findByCompetition.mockResolvedValue([entry()]);

    const result = await service.findByCompetition(COMPETITION_ID);
    const [category] = result.categories;
    const [singleEntry] = category.entries;

    expect(singleEntry).toEqual({
      id: "entry-1",
      name: "Dupont Jean",
      club: "TKD Paris",
      league: "IDF",
      country: "France",
    });
    expect(category).not.toHaveProperty("source");
    expect(category).not.toHaveProperty("created_at");
  });

  it("trie les entries au sein d'une catégorie par nom (ordre alphabétique)", async () => {
    competitionsRepository.findById.mockResolvedValue({ id: COMPETITION_ID });
    entriesRepository.findByCompetition.mockResolvedValue([
      entry({ id: "e1", participant_name: "Zidane Marc" }),
      entry({ id: "e2", participant_name: "Alaoui Sarah" }),
      entry({ id: "e3", participant_name: "Martin Léa" }),
    ]);

    const result = await service.findByCompetition(COMPETITION_ID);

    expect(result.categories[0].entries.map((e) => e.name)).toEqual([
      "Alaoui Sarah",
      "Martin Léa",
      "Zidane Marc",
    ]);
  });

  it("trie les catégories par ageCategory puis gender puis weightCategory, rawLabel en filet de sécurité", async () => {
    competitionsRepository.findById.mockResolvedValue({ id: COMPETITION_ID });
    entriesRepository.findByCompetition.mockResolvedValue([
      entry({
        id: "e1",
        source_category_raw_label: "Seniors Masculins -87 kg",
        age_category: "Senior",
        gender: "male",
        weight_category: "-87 kg",
      }),
      entry({
        id: "e2",
        source_category_raw_label: "Cadets Masculins -55 kg",
        age_category: "Cadet",
        gender: "male",
        weight_category: "-55 kg",
      }),
      entry({
        id: "e3",
        source_category_raw_label: "Seniors Féminines -46 kg",
        age_category: "Senior",
        gender: "female",
        weight_category: "-46 kg",
      }),
    ]);

    const result = await service.findByCompetition(COMPETITION_ID);

    expect(result.categories.map((c) => c.rawLabel)).toEqual([
      "Cadets Masculins -55 kg",
      "Seniors Féminines -46 kg",
      "Seniors Masculins -87 kg",
    ]);
  });

  it("catégorie sans ageCategory/gender/weightCategory (ex. Poomsae) est triée après les catégories renseignées, via rawLabel", async () => {
    competitionsRepository.findById.mockResolvedValue({ id: COMPETITION_ID });
    entriesRepository.findByCompetition.mockResolvedValue([
      entry({
        id: "e1",
        source_category_raw_label: "Poomsae Camp",
        age_category: null,
        gender: null,
        weight_category: null,
      }),
      entry({
        id: "e2",
        source_category_raw_label: "Seniors Masculins -74 kg",
        age_category: "Senior",
        gender: "male",
        weight_category: "-74 kg",
      }),
    ]);

    const result = await service.findByCompetition(COMPETITION_ID);

    expect(result.categories.map((c) => c.rawLabel)).toEqual([
      "Seniors Masculins -74 kg",
      "Poomsae Camp",
    ]);
  });

  it("conserve des valeurs null (club/league/country/ageCategory absents) sans les fabriquer", async () => {
    competitionsRepository.findById.mockResolvedValue({ id: COMPETITION_ID });
    entriesRepository.findByCompetition.mockResolvedValue([
      entry({
        id: "e1",
        source_category_raw_label: "Poomsae Camp",
        age_category: null,
        gender: null,
        weight_category: null,
        club: null,
        league: null,
        country: null,
      }),
    ]);

    const result = await service.findByCompetition(COMPETITION_ID);
    const [category] = result.categories;

    expect(category.ageCategory).toBeNull();
    expect(category.gender).toBeNull();
    expect(category.weightCategory).toBeNull();
    expect(category.entries[0].club).toBeNull();
    expect(category.entries[0].league).toBeNull();
    expect(category.entries[0].country).toBeNull();
  });
});
