import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, NotFoundException } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { InternationalAthletesController } from "./international-athletes.controller";
import { CompetitionMatchesController } from "./competition-matches.controller";
import { InternationalService } from "./international.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

// HTTP réel (supertest) : ParseUUIDPipe (400) et JwtAuthGuard (401) ne
// s'appliquent que via le pipeline Nest.
describe("International controllers (HTTP)", () => {
  let app: INestApplication;
  let service: { getAthlete: jest.Mock; getAthleteMatches: jest.Mock; getCompetitionMatches: jest.Mock };
  let cookie: string;

  const ID = "2e5709b9-7385-4a79-be70-ddd3c573ae51";

  beforeEach(async () => {
    service = { getAthlete: jest.fn(), getAthleteMatches: jest.fn(), getCompetitionMatches: jest.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [InternationalAthletesController, CompetitionMatchesController],
      providers: [{ provide: InternationalService, useValue: service }, JwtAuthGuard],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();
    cookie = authCookieHeader(signTestToken({ sub: "user-1", athleteId: "athlete-1" }));
  });

  afterEach(async () => {
    await app.close();
  });

  describe.each([
    ["GET /international-athletes/:id", `/international-athletes/${ID}`],
    ["GET /international-athletes/:id/matches", `/international-athletes/${ID}/matches`],
    ["GET /competitions/:competitionId/matches", `/competitions/${ID}/matches`],
  ])("%s", (_label, url) => {
    it("sans authentification -> 401, service jamais appelé", async () => {
      await request(app.getHttpServer()).get(url).expect(401);
      expect(service.getAthlete).not.toHaveBeenCalled();
      expect(service.getAthleteMatches).not.toHaveBeenCalled();
      expect(service.getCompetitionMatches).not.toHaveBeenCalled();
    });

    it("UUID invalide -> 400", async () => {
      await request(app.getHttpServer()).get(url.replace(ID, "not-a-uuid")).set("Cookie", cookie).expect(400);
    });
  });

  it("GET /international-athletes/:id -> 200 avec la vue du service", async () => {
    service.getAthlete.mockResolvedValue({ id: ID, displayName: "Alice EXEMPLE" });
    const res = await request(app.getHttpServer()).get(`/international-athletes/${ID}`).set("Cookie", cookie).expect(200);
    expect(res.body).toEqual({ id: ID, displayName: "Alice EXEMPLE" });
    expect(service.getAthlete).toHaveBeenCalledWith(ID);
  });

  it("athlète inconnu -> 404 (erreur du service propagée)", async () => {
    service.getAthlete.mockRejectedValue(new NotFoundException("introuvable"));
    await request(app.getHttpServer()).get(`/international-athletes/${ID}`).set("Cookie", cookie).expect(404);
  });

  it("GET /international-athletes/:id/matches : pagination par défaut 1/20", async () => {
    service.getAthleteMatches.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
    await request(app.getHttpServer()).get(`/international-athletes/${ID}/matches`).set("Cookie", cookie).expect(200);
    expect(service.getAthleteMatches).toHaveBeenCalledWith(ID, 1, 20);
  });

  it("GET /competitions/:competitionId/matches : transmet page et limit", async () => {
    service.getCompetitionMatches.mockResolvedValue({ items: [], total: 0, page: 2, limit: 10 });
    await request(app.getHttpServer()).get(`/competitions/${ID}/matches?page=2&limit=10`).set("Cookie", cookie).expect(200);
    expect(service.getCompetitionMatches).toHaveBeenCalledWith(ID, 2, 10);
  });

  it("competition inconnue -> 404", async () => {
    service.getCompetitionMatches.mockRejectedValue(new NotFoundException("introuvable"));
    await request(app.getHttpServer()).get(`/competitions/${ID}/matches`).set("Cookie", cookie).expect(404);
  });

  it.each([
    ["page=0", "page=0"],
    ["page=abc", "page=abc"],
    ["limit=0", "limit=0"],
    ["limit=51 (max 50)", "limit=51"],
    ["limit=1.5", "limit=1.5"],
  ])("paramètre invalide (%s) -> 400, service jamais appelé", async (_l, qs) => {
    await request(app.getHttpServer()).get(`/international-athletes/${ID}/matches?${qs}`).set("Cookie", cookie).expect(400);
    await request(app.getHttpServer()).get(`/competitions/${ID}/matches?${qs}`).set("Cookie", cookie).expect(400);
    expect(service.getAthleteMatches).not.toHaveBeenCalled();
    expect(service.getCompetitionMatches).not.toHaveBeenCalled();
  });
});
