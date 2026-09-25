import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, NotFoundException } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { CompetitionsController } from "./competitions.controller";
import { CompetitionsService } from "./competitions.service";
import { CompetitionEntriesService } from "./competition-entries.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

// Test au niveau HTTP (via supertest) plutôt qu'un simple appel direct au
// contrôleur : ParseUUIDPipe (400) et JwtAuthGuard (401) ne s'appliquent que
// via le pipeline de requête réel de Nest.
describe("CompetitionsController (HTTP) - GET /competitions/:competitionId", () => {
  let app: INestApplication;
  let service: { findOne: jest.Mock; findAll: jest.Mock; findAllPaginated: jest.Mock; listYears: jest.Mock };
  let entriesService: { findByCompetition: jest.Mock };

  const VALID_COMPETITION_ID = "2e5709b9-7385-4a79-be70-ddd3c573ae51";

  let authCookie: string;

  beforeEach(async () => {
    service = { findOne: jest.fn(), findAll: jest.fn(), findAllPaginated: jest.fn(), listYears: jest.fn() };
    entriesService = { findByCompetition: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [CompetitionsController],
      providers: [
        { provide: CompetitionsService, useValue: service },
        { provide: CompetitionEntriesService, useValue: entriesService },
        JwtAuthGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    authCookie = authCookieHeader(signTestToken({ sub: "user-1", athleteId: "athlete-1" }));
  });

  afterEach(async () => {
    await app.close();
  });

  it("sans authentification -> 401, service jamais appelé", async () => {
    await request(app.getHttpServer())
      .get(`/competitions/${VALID_COMPETITION_ID}`)
      .expect(401);

    expect(service.findOne).not.toHaveBeenCalled();
  });

  it("UUID invalide -> 400, service jamais appelé", async () => {
    await request(app.getHttpServer())
      .get("/competitions/not-a-uuid")
      .set("Cookie", authCookie)
      .expect(400);

    expect(service.findOne).not.toHaveBeenCalled();
  });

  it("compétition inconnue -> 404", async () => {
    service.findOne.mockRejectedValue(
      new NotFoundException(`Competition ${VALID_COMPETITION_ID} introuvable`),
    );

    await request(app.getHttpServer())
      .get(`/competitions/${VALID_COMPETITION_ID}`)
      .set("Cookie", authCookie)
      .expect(404);
  });

  it("compétition existante -> 200, réponse ne contient que les champs attendus", async () => {
    const view = {
      id: VALID_COMPETITION_ID,
      nom: "Paris 2026 World Taekwondo Grand Prix Series",
      organisateur: null,
      source: "world_taekwondo",
      sourceExternalId: "26025",
      dateDebut: "2026-10-09",
      dateFin: "2026-10-11",
      lieu: null,
      ville: "Paris",
      pays: "France",
      niveau: "international",
      saison: null,
      sources: [
        { source: "fftda", sourceUrl: null },
        { source: "world_taekwondo", sourceUrl: null },
      ],
    };
    service.findOne.mockResolvedValue(view);

    const response = await request(app.getHttpServer())
      .get(`/competitions/${VALID_COMPETITION_ID}`)
      .set("Cookie", authCookie)
      .expect(200);

    expect(response.body).toEqual(view);
    expect(Object.keys(response.body).sort()).toEqual(
      [
        "id",
        "nom",
        "organisateur",
        "source",
        "sourceExternalId",
        "dateDebut",
        "dateFin",
        "lieu",
        "ville",
        "pays",
        "niveau",
        "saison",
        "sources",
      ].sort(),
    );
    // null reste null, jamais réécrit/omis par la sérialisation HTTP.
    expect(response.body.organisateur).toBeNull();
    expect(response.body.lieu).toBeNull();
    expect(response.body.saison).toBeNull();
  });

  describe("GET /competitions — pagination (ticket Compétitions Athlete V2 §8)", () => {
    it("sans page/limit -> service.findAll (comportement historique, réponse = tableau brut)", async () => {
      service.findAll.mockResolvedValue([{ id: "c1" }]);

      const response = await request(app.getHttpServer())
        .get("/competitions")
        .set("Cookie", authCookie)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(service.findAll).toHaveBeenCalledWith(undefined);
    });

    it("sans authentification -> 200 quand même (GET /competitions reste public, aucun guard)", async () => {
      service.findAll.mockResolvedValue([]);
      await request(app.getHttpServer()).get("/competitions").expect(200);
    });

    it("avec page/limit -> service.findAllPaginated, réponse = {items,total,page,limit}", async () => {
      service.findAllPaginated.mockResolvedValue({ items: [{ id: "c1" }], total: 1, page: 1, limit: 20 });

      const response = await request(app.getHttpServer())
        .get("/competitions?page=1&limit=20&scope=upcoming")
        .set("Cookie", authCookie)
        .expect(200);

      expect(response.body).toEqual({ items: [{ id: "c1" }], total: 1, page: 1, limit: 20 });
      expect(service.findAllPaginated).toHaveBeenCalledWith({
        search: undefined,
        page: 1,
        limit: 20,
        scope: "upcoming",
        year: undefined,
      });
    });

    it("year transmis (entier), compose avec scope et search", async () => {
      service.findAllPaginated.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
      await request(app.getHttpServer()).get("/competitions?page=1&limit=20&scope=past&year=2025&search=open").expect(200);
      expect(service.findAllPaginated).toHaveBeenCalledWith({ search: "open", page: 1, limit: 20, scope: "past", year: 2025 });
    });

    it.each(["abc", "2025.5", "1999", "2101", "-2025"])("year invalide (%s) -> 400, service jamais appelé", async (year) => {
      await request(app.getHttpServer()).get(`/competitions?page=1&limit=20&year=${year}`).expect(400);
      expect(service.findAllPaginated).not.toHaveBeenCalled();
    });

    it("GET /competitions/years -> années disponibles (jamais interprété comme un :competitionId)", async () => {
      service.listYears.mockResolvedValue({ years: [2026, 2025] });
      const response = await request(app.getHttpServer()).get("/competitions/years").expect(200);
      expect(response.body).toEqual({ years: [2026, 2025] });
    });

    it("scope invalide -> 400", async () => {
      await request(app.getHttpServer())
        .get("/competitions?page=1&limit=20&scope=bientot")
        .set("Cookie", authCookie)
        .expect(400);
    });

    it("limit > 50 -> 400", async () => {
      await request(app.getHttpServer())
        .get("/competitions?page=1&limit=500")
        .set("Cookie", authCookie)
        .expect(400);
    });
  });

  describe("GET /competitions/:competitionId/entries", () => {
    it("sans authentification -> 401, service jamais appelé", async () => {
      await request(app.getHttpServer())
        .get(`/competitions/${VALID_COMPETITION_ID}/entries`)
        .expect(401);

      expect(entriesService.findByCompetition).not.toHaveBeenCalled();
    });

    it("UUID invalide -> 400, service jamais appelé", async () => {
      await request(app.getHttpServer())
        .get("/competitions/not-a-uuid/entries")
        .set("Cookie", authCookie)
        .expect(400);

      expect(entriesService.findByCompetition).not.toHaveBeenCalled();
    });

    it("competition inconnue -> 404", async () => {
      entriesService.findByCompetition.mockRejectedValue(
        new NotFoundException(`Competition ${VALID_COMPETITION_ID} introuvable`),
      );

      await request(app.getHttpServer())
        .get(`/competitions/${VALID_COMPETITION_ID}/entries`)
        .set("Cookie", authCookie)
        .expect(404);
    });

    it("competition sans entries -> 200, categories: []", async () => {
      entriesService.findByCompetition.mockResolvedValue({
        competitionId: VALID_COMPETITION_ID,
        categories: [],
        totalEntries: 0,
      });

      const response = await request(app.getHttpServer())
        .get(`/competitions/${VALID_COMPETITION_ID}/entries`)
        .set("Cookie", authCookie)
        .expect(200);

      expect(response.body).toEqual({
        competitionId: VALID_COMPETITION_ID,
        categories: [],
        totalEntries: 0,
      });
    });

    it("competition avec entries -> 200, structure par catégorie", async () => {
      const view = {
        competitionId: VALID_COMPETITION_ID,
        categories: [
          {
            rawLabel: "Seniors Masculins -74 kg",
            ageCategory: "Senior",
            gender: "male",
            weightCategory: "-74 kg",
            entries: [{ id: "e1", name: "Dupont Jean", club: "TKD Paris", league: "IDF", country: "France" }],
          },
        ],
        totalEntries: 1,
      };
      entriesService.findByCompetition.mockResolvedValue(view);

      const response = await request(app.getHttpServer())
        .get(`/competitions/${VALID_COMPETITION_ID}/entries`)
        .set("Cookie", authCookie)
        .expect(200);

      expect(response.body).toEqual(view);
    });
  });
});
