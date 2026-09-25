import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { CompetitionsService } from "./competitions.service";
import { CompetitionsRepository } from "./competitions.repository";
import { CompetitionEntriesRepository } from "./competition-entries.repository";
import { FftdaImporterService } from "./importers/fftda-importer.service";
import { WtImporterService } from "./importers/world-taekwondo/wt-importer.service";
import { MartialEventsImporterService } from "./importers/martial-events/me-importer.service";
import { ImportedCompetition } from "./importers/imported-competition.interface";

describe("CompetitionsService", () => {
  let service: CompetitionsService;
  let repository: { upsertFromSource: jest.Mock; findMany: jest.Mock; findById: jest.Mock };
  let entriesRepository: { syncForCompetition: jest.Mock };
  let importer: { fetchCompetitions: jest.Mock };
  let wtImporter: { fetchCompetitions: jest.Mock };
  let meImporter: {
    discoverUpcomingEvents: jest.Mock;
    fetchCompetition: jest.Mock;
    fetchEntries: jest.Mock;
  };

  const competitions: ImportedCompetition[] = [
    {
      source: "fftda",
      sourceExternalId: "509",
      nom: "Championnat de France Juniors",
      dateDebut: new Date(Date.UTC(2027, 4, 9)),
    },
    {
      source: "fftda",
      sourceExternalId: "451",
      nom: "Open Labellisé de Poissy",
      dateDebut: new Date(Date.UTC(2026, 1, 7)),
    },
  ];

  const wtCompetitions: ImportedCompetition[] = [
    {
      source: "world_taekwondo",
      sourceExternalId: "26032",
      nom: "13th Fujairah International Taekwondo Open Championships",
      dateDebut: new Date(Date.UTC(2026, 1, 1)),
      dateFin: new Date(Date.UTC(2026, 1, 4)),
      ville: "Fujairah",
      pays: "United Arab Emirates",
      niveau: "international",
    },
  ];

  beforeEach(async () => {
    repository = { upsertFromSource: jest.fn(), findMany: jest.fn(), findById: jest.fn() };
    entriesRepository = { syncForCompetition: jest.fn() };
    importer = { fetchCompetitions: jest.fn() };
    wtImporter = { fetchCompetitions: jest.fn() };
    meImporter = {
      discoverUpcomingEvents: jest.fn(),
      fetchCompetition: jest.fn(),
      fetchEntries: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompetitionsService,
        { provide: CompetitionsRepository, useValue: repository },
        { provide: CompetitionEntriesRepository, useValue: entriesRepository },
        { provide: FftdaImporterService, useValue: importer },
        { provide: WtImporterService, useValue: wtImporter },
        { provide: MartialEventsImporterService, useValue: meImporter },
      ],
    }).compile();

    service = module.get<CompetitionsService>(CompetitionsService);
  });

  it("retourne un résumé imported/updated/failed cohérent avec le résultat de l'import", async () => {
    importer.fetchCompetitions.mockResolvedValue({ detected: 2, competitions, failed: 0 });
    repository.upsertFromSource
      .mockResolvedValueOnce({ competition: {}, created: true })
      .mockResolvedValueOnce({ competition: {}, created: true });

    const summary = await service.importFftda();

    expect(summary).toEqual({
      source: "fftda",
      fetched: 2,
      imported: 2,
      updated: 0,
      failed: 0,
    });
    expect(repository.upsertFromSource).toHaveBeenCalledTimes(2);
  });

  it("relancer un import identique ne crée aucun doublon : la deuxième exécution ne fait que des mises à jour", async () => {
    importer.fetchCompetitions.mockResolvedValue({ detected: 2, competitions, failed: 0 });

    repository.upsertFromSource
      .mockResolvedValueOnce({ competition: {}, created: true })
      .mockResolvedValueOnce({ competition: {}, created: true });
    const firstRun = await service.importFftda();

    repository.upsertFromSource
      .mockResolvedValueOnce({ competition: {}, created: false })
      .mockResolvedValueOnce({ competition: {}, created: false });
    const secondRun = await service.importFftda();

    expect(firstRun).toEqual({ source: "fftda", fetched: 2, imported: 2, updated: 0, failed: 0 });
    expect(secondRun).toEqual({ source: "fftda", fetched: 2, imported: 0, updated: 2, failed: 0 });

    const [firstCallArg] = repository.upsertFromSource.mock.calls[0];
    const [thirdCallArg] = repository.upsertFromSource.mock.calls[2];
    expect(thirdCallArg.sourceExternalId).toBe(firstCallArg.sourceExternalId);
  });

  it("comptabilise en échec un item non normalisable par l'importer sans planter tout l'import", async () => {
    importer.fetchCompetitions.mockResolvedValue({ detected: 3, competitions, failed: 1 });
    repository.upsertFromSource
      .mockResolvedValueOnce({ competition: {}, created: true })
      .mockResolvedValueOnce({ competition: {}, created: true });

    const summary = await service.importFftda();

    expect(summary).toEqual({ source: "fftda", fetched: 3, imported: 2, updated: 0, failed: 1 });
  });

  it("comptabilise en échec un upsert qui lève une erreur, sans interrompre les autres compétitions", async () => {
    importer.fetchCompetitions.mockResolvedValue({ detected: 2, competitions, failed: 0 });
    repository.upsertFromSource
      .mockResolvedValueOnce({ competition: {}, created: true })
      .mockRejectedValueOnce(new Error("erreur Prisma inattendue"));

    const summary = await service.importFftda();

    expect(summary).toEqual({ source: "fftda", fetched: 2, imported: 1, updated: 0, failed: 1 });
  });

  it("importWorldTaekwondo retourne un résumé cohérent incluant l'année demandée", async () => {
    wtImporter.fetchCompetitions.mockResolvedValue({ detected: 1, competitions: wtCompetitions, failed: 0 });
    repository.upsertFromSource.mockResolvedValueOnce({ competition: {}, created: true });

    const summary = await service.importWorldTaekwondo(2026);

    expect(summary).toEqual({
      source: "world_taekwondo",
      year: 2026,
      fetched: 1,
      imported: 1,
      updated: 0,
      failed: 0,
    });
    expect(wtImporter.fetchCompetitions).toHaveBeenCalledWith(2026);
  });

  it("importWorldTaekwondo relancé deux fois ne crée aucun doublon", async () => {
    wtImporter.fetchCompetitions.mockResolvedValue({ detected: 1, competitions: wtCompetitions, failed: 0 });

    repository.upsertFromSource.mockResolvedValueOnce({ competition: {}, created: true });
    const firstRun = await service.importWorldTaekwondo(2026);

    repository.upsertFromSource.mockResolvedValueOnce({ competition: {}, created: false });
    const secondRun = await service.importWorldTaekwondo(2026);

    expect(firstRun).toEqual({
      source: "world_taekwondo",
      year: 2026,
      fetched: 1,
      imported: 1,
      updated: 0,
      failed: 0,
    });
    expect(secondRun).toEqual({
      source: "world_taekwondo",
      year: 2026,
      fetched: 1,
      imported: 0,
      updated: 1,
      failed: 0,
    });
  });

  describe("importMartialEvents", () => {
    const discovered = [
      { slug: "open-de-bordeaux-metropole-2026", name: "Open de Bordeaux Métropole", countryCode: "fr" },
      { slug: "9eme-open-villeneuve", name: "9eme Open International de Villeneuve sur lot", countryCode: "fr" },
    ];

    const meCompetitionA: ImportedCompetition = {
      source: "martial_events",
      sourceExternalId: "1",
      nom: "Open de Bordeaux Métropole",
      dateDebut: new Date(Date.UTC(2026, 8, 19)),
      ville: "Pessac",
      pays: "France",
    };
    const meCompetitionB: ImportedCompetition = {
      source: "martial_events",
      sourceExternalId: "2",
      nom: "9eme Open International de Villeneuve sur lot",
      dateDebut: new Date(Date.UTC(2026, 9, 10)),
      ville: "Villeneuve-sur-Lot",
      pays: "France",
    };

    const emptySync = { imported: 0, updated: 0, removed: 0, total: 0 };

    beforeEach(() => {
      meImporter.fetchEntries.mockResolvedValue([]);
      entriesRepository.syncForCompetition.mockResolvedValue(emptySync);
    });

    it("discover -> fetchCompetition -> upsert -> fetchEntries -> sync, résumé complet", async () => {
      meImporter.discoverUpcomingEvents.mockResolvedValue(discovered);
      meImporter.fetchCompetition.mockResolvedValueOnce(meCompetitionA).mockResolvedValueOnce(meCompetitionB);
      repository.upsertFromSource
        .mockResolvedValueOnce({ competition: { id: "comp-a" }, created: true, outcome: "created" })
        .mockResolvedValueOnce({ competition: { id: "comp-b" }, created: true, outcome: "created" });
      entriesRepository.syncForCompetition
        .mockResolvedValueOnce({ imported: 28, updated: 0, removed: 0, total: 28 })
        .mockResolvedValueOnce({ imported: 13, updated: 0, removed: 0, total: 13 });

      const summary = await service.importMartialEvents();

      expect(summary).toEqual({
        source: "martial_events",
        fetched: 2,
        imported: 2,
        updated: 0,
        attached: 0,
        failed: 0,
        entriesImported: 41,
        entriesUpdated: 0,
        entriesRemoved: 0,
        entriesFailed: 0,
      });
      expect(meImporter.fetchCompetition).toHaveBeenNthCalledWith(1, discovered[0].slug);
      expect(meImporter.fetchCompetition).toHaveBeenNthCalledWith(2, discovered[1].slug);
      expect(entriesRepository.syncForCompetition).toHaveBeenNthCalledWith(1, "comp-a", "martial_events", []);
      expect(entriesRepository.syncForCompetition).toHaveBeenNthCalledWith(2, "comp-b", "martial_events", []);
    });

    it("comptabilise séparément un rattachement SAFE ('attached') d'une simple mise à jour ('updated')", async () => {
      meImporter.discoverUpcomingEvents.mockResolvedValue([discovered[0]]);
      meImporter.fetchCompetition.mockResolvedValue(meCompetitionA);
      repository.upsertFromSource.mockResolvedValueOnce({
        competition: { id: "comp-a" },
        created: false,
        outcome: "attachedSafe",
      });

      const summary = await service.importMartialEvents();

      expect(summary).toMatchObject({ imported: 0, updated: 0, attached: 1, failed: 0 });
    });

    it("synchronise toujours les entries sur l'id competition canonique retourné par l'upsert, jamais un id Martial Events", async () => {
      meImporter.discoverUpcomingEvents.mockResolvedValue([discovered[0]]);
      meImporter.fetchCompetition.mockResolvedValue(meCompetitionA);
      repository.upsertFromSource.mockResolvedValueOnce({
        competition: { id: "canonical-uuid" },
        created: false,
        outcome: "attachedSafe",
      });

      await service.importMartialEvents();

      expect(entriesRepository.syncForCompetition).toHaveBeenCalledWith(
        "canonical-uuid",
        "martial_events",
        [],
      );
    });

    it("comptabilise en échec un événement dont la normalisation échoue (competition null), sans interrompre les autres", async () => {
      meImporter.discoverUpcomingEvents.mockResolvedValue(discovered);
      meImporter.fetchCompetition.mockResolvedValueOnce(null).mockResolvedValueOnce(meCompetitionB);
      repository.upsertFromSource.mockResolvedValueOnce({
        competition: { id: "comp-b" },
        created: true,
        outcome: "created",
      });

      const summary = await service.importMartialEvents();

      expect(summary).toMatchObject({ imported: 1, updated: 0, attached: 0, failed: 1 });
    });

    it("un échec de fetchEntries ne bloque pas l'import des autres compétitions et ne touche pas aux entries existantes", async () => {
      meImporter.discoverUpcomingEvents.mockResolvedValue(discovered);
      meImporter.fetchCompetition.mockResolvedValueOnce(meCompetitionA).mockResolvedValueOnce(meCompetitionB);
      repository.upsertFromSource
        .mockResolvedValueOnce({ competition: { id: "comp-a" }, created: true, outcome: "created" })
        .mockResolvedValueOnce({ competition: { id: "comp-b" }, created: true, outcome: "created" });
      meImporter.fetchEntries
        .mockRejectedValueOnce(new Error("Martial.Events est actuellement indisponible"))
        .mockResolvedValueOnce([]);

      const summary = await service.importMartialEvents();

      expect(summary.entriesFailed).toBe(1);
      // syncForCompetition n'est jamais appelé pour la compétition dont le
      // fetch des entries a échoué (jamais de sync sur une lecture ratée).
      expect(entriesRepository.syncForCompetition).toHaveBeenCalledTimes(1);
      expect(entriesRepository.syncForCompetition).toHaveBeenCalledWith("comp-b", "martial_events", []);
    });

    it("réimport identique : la deuxième exécution ne fait que des mises à jour (idempotence)", async () => {
      meImporter.discoverUpcomingEvents.mockResolvedValue([discovered[0]]);
      meImporter.fetchCompetition.mockResolvedValue(meCompetitionA);

      repository.upsertFromSource.mockResolvedValueOnce({
        competition: { id: "comp-a" },
        created: true,
        outcome: "created",
      });
      const first = await service.importMartialEvents();

      repository.upsertFromSource.mockResolvedValueOnce({
        competition: { id: "comp-a" },
        created: false,
        outcome: "updated",
      });
      const second = await service.importMartialEvents();

      expect(first.imported).toBe(1);
      expect(second.imported).toBe(0);
      expect(second.updated).toBe(1);
    });
  });

  describe("findOne", () => {
    const dbCompetition = {
      id: "2e5709b9-7385-4a79-be70-ddd3c573ae51",
      nom: "Paris 2026 World Taekwondo Grand Prix Series",
      organisateur: null,
      source: "world_taekwondo",
      source_external_id: "26025",
      date_debut: new Date(Date.UTC(2026, 9, 9)),
      date_fin: new Date(Date.UTC(2026, 9, 11)),
      lieu: null,
      ville: "Paris",
      pays: "France",
      niveau: "international",
      saison: null,
      created_at: new Date(),
      updated_at: new Date(),
      all_sources: [
        { source: "fftda", source_url: null },
        { source: "world_taekwondo", source_url: "https://example.org/wt/26025" },
      ],
      counts: { entries: 0, matches: 234 },
    };

    it("retourne une vue stable (jamais l'objet Prisma brut) quand la compétition existe", async () => {
      repository.findById.mockResolvedValue(dbCompetition);

      const result = await service.findOne(dbCompetition.id);

      expect(result).toEqual({
        id: dbCompetition.id,
        nom: dbCompetition.nom,
        organisateur: null,
        source: "world_taekwondo",
        sourceExternalId: "26025",
        dateDebut: dbCompetition.date_debut,
        dateFin: dbCompetition.date_fin,
        lieu: null,
        ville: "Paris",
        pays: "France",
        niveau: "international",
        saison: null,
        sources: [
          { source: "fftda", sourceUrl: null },
          { source: "world_taekwondo", sourceUrl: "https://example.org/wt/26025" },
        ],
        availability: { entryCount: 0, matchCount: 234 },
      });
      // Jamais l'objet Prisma brut : pas de created_at/updated_at exposés.
      expect(result).not.toHaveProperty("created_at");
      expect(result).not.toHaveProperty("updated_at");
    });

    it("availability : inscrits et combats comptés séparément, 0 conservé (jamais confondu avec absent)", async () => {
      repository.findById.mockResolvedValue({ ...dbCompetition, counts: { entries: 12, matches: 0 } });

      const result = await service.findOne(dbCompetition.id);

      expect(result.availability).toEqual({ entryCount: 12, matchCount: 0 });
    });

    it("ne fabrique jamais organisateur/lieu/saison : une valeur null en base reste null dans la vue", async () => {
      repository.findById.mockResolvedValue(dbCompetition);

      const result = await service.findOne(dbCompetition.id);

      expect(result.organisateur).toBeNull();
      expect(result.lieu).toBeNull();
      expect(result.saison).toBeNull();
    });

    it("lève NotFoundException quand la compétition n'existe pas", async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findOne("aaaaaaaa-1111-4111-8111-111111111111")).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
