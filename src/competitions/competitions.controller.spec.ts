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
  let service: { findOne: jest.Mock; findAll: jest.Mock };
  let entriesService: { findByCompetition: jest.Mock };

  const VALID_COMPETITION_ID = "2e5709b9-7385-4a79-be70-ddd3c573ae51";

  let authCookie: string;

  beforeEach(async () => {
    service = { findOne: jest.fn(), findAll: jest.fn() };
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
      ].sort(),
    );
    // null reste null, jamais réécrit/omis par la sérialisation HTTP.
    expect(response.body.organisateur).toBeNull();
    expect(response.body.lieu).toBeNull();
    expect(response.body.saison).toBeNull();
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
