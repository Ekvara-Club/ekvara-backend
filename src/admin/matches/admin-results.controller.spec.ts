import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { TEST_JWT_SECRET } from "../../test-utils/auth-test.helper";
import { AdminAuditLogger } from "../admin-audit.logger";
import { AdminGuard } from "../admin.guard";
import { ADMIN_COOKIE_NAME, ADMIN_CSRF_HEADER } from "../admin-session";
import { ADMIN_JWT, ADMIN_USER_IDS, createAdminJwtService } from "../admin-tokens";
import { AdminEntriesController } from "../entries/admin-entries.controller";
import { AdminEntriesService } from "../entries/admin-entries.service";
import { AdminMatchesController } from "./admin-matches.controller";
import { AdminMatchesService } from "./admin-matches.service";

const ADMIN_ID = "0b6f3c1e-2a4d-4e5f-9a7b-1c2d3e4f5a6b";
const COMPETITION_ID = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const ATHLETE_A = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const ATHLETE_B = "6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e";
const CSRF = "csrf-de-test";

// Câblage HTTP réel (ValidationPipe de main.ts, AdminGuard réel) des
// participants et des combats ; services simulés (comportement couvert par
// la spec d'intégration Postgres).
describe("Participants et combats (HTTP)", () => {
  let app: INestApplication;
  let entries: Record<string, jest.Mock>;
  let matches: Record<string, jest.Mock>;
  let cookie: string;

  beforeEach(async () => {
    const ok = () => jest.fn().mockResolvedValue({ ok: true });
    entries = { list: ok(), previewCreate: ok(), create: ok(), previewUpdate: ok(), update: ok() };
    matches = { summary: ok(), listCategory: ok(), previewCreate: ok(), create: ok(), get: ok(), previewUpdate: ok(), update: ok() };
    const adminJwt = createAdminJwtService(TEST_JWT_SECRET);
    cookie = `${ADMIN_COOKIE_NAME}=${adminJwt.sign({ sub: ADMIN_ID, csrf: CSRF })}`;
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminEntriesController, AdminMatchesController],
      providers: [
        AdminGuard,
        { provide: AdminEntriesService, useValue: entries },
        { provide: AdminMatchesService, useValue: matches },
        { provide: AdminAuditLogger, useValue: { record: jest.fn(), denied: jest.fn() } },
        { provide: ADMIN_JWT, useValue: adminJwt },
        { provide: ADMIN_USER_IDS, useValue: new Set([ADMIN_ID]) },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const MATCH = { category: "Men -58kg", athleteAId: ATHLETE_A, athleteBId: ATHLETE_B };
  const ENTRY = { participantName: "Emma DUBOIS", category: "Seniors F -57kg" };
  const postMatch = (body: object) =>
    http().post(`/admin/competitions/${COMPETITION_ID}/matches`).set("Cookie", cookie).set(ADMIN_CSRF_HEADER, CSRF).send(body);
  const postEntry = (body: object) =>
    http().post(`/admin/competitions/${COMPETITION_ID}/entries`).set("Cookie", cookie).set(ADMIN_CSRF_HEADER, CSRF).send(body);

  it("sans session -> 401 ; écriture sans jeton CSRF -> 403 ; services jamais appelés", async () => {
    await http().get(`/admin/competitions/${COMPETITION_ID}/entries`).expect(401);
    await http().get(`/admin/competitions/${COMPETITION_ID}/matches`).expect(401);
    await http().post(`/admin/competitions/${COMPETITION_ID}/matches`).set("Cookie", cookie).send(MATCH).expect(403);
    await http().post(`/admin/competitions/${COMPETITION_ID}/entries`).set("Cookie", cookie).send(ENTRY).expect(403);
    await http().patch(`/admin/matches/${COMPETITION_ID}`).set("Cookie", cookie).send(MATCH).expect(403);
    await http().patch(`/admin/entries/${COMPETITION_ID}`).set("Cookie", cookie).send(ENTRY).expect(403);
    expect(matches.create).not.toHaveBeenCalled();
    expect(entries.create).not.toHaveBeenCalled();
  });

  it.each([
    ["catégorie manquante", { athleteAId: ATHLETE_A, athleteBId: ATHLETE_B }],
    ["athlète non UUID", { ...MATCH, athleteBId: "kim" }],
    ["score négatif", { ...MATCH, scoreA: -1 }],
    ["score non entier", { ...MATCH, scoreB: 1.5 }],
    ["score en texte", { ...MATCH, scoreA: "2" }],
    ["vainqueur hors combat", { ...MATCH, winner: "C" }],
    ["vainqueur désigné par identifiant (refusé : côté A/B uniquement)", { ...MATCH, winner: ATHLETE_A }],
    ["tour inconnu", { ...MATCH, bracketStage: "Finale" }],
    ["numéro de combat négatif", { ...MATCH, contestNumber: -3 }],
    ["méthode non conforme", { ...MATCH, resultMethod: "par KO" }],
    ["date au mauvais format", { ...MATCH, occurredOn: "12/03/2026" }],
    ["champ inconnu", { ...MATCH, winnerAthleteId: ATHLETE_A }],
  ])("combat : %s -> 400", async (_label, body) => {
    await postMatch(body).expect(400);
    expect(matches.create).not.toHaveBeenCalled();
  });

  it("combat : normalisation (catégorie sans espaces superflus, méthode en majuscules, inconnu -> null)", async () => {
    await postMatch({ ...MATCH, category: "  Men   -58kg ", resultMethod: "ptf", bracketStage: "", occurredOn: "" }).expect(201);
    expect(matches.create).toHaveBeenCalledWith(
      COMPETITION_ID,
      expect.objectContaining({ category: "Men -58kg", resultMethod: "PTF", bracketStage: null, occurredOn: null }),
      ADMIN_ID,
    );
  });

  it.each([
    ["nom manquant", { category: "Seniors" }],
    ["catégorie manquante", { participantName: "Emma" }],
    ["genre hors convention", { ...ENTRY, gender: "F" }],
    ["champ inconnu (compte EKVARA)", { ...ENTRY, athleteId: ATHLETE_A }],
  ])("participant : %s -> 400", async (_label, body) => {
    await postEntry(body).expect(400);
    expect(entries.create).not.toHaveBeenCalled();
  });

  it("liste des combats d'une catégorie : paramètre requis et borné", async () => {
    await http().get(`/admin/competitions/${COMPETITION_ID}/matches/list`).set("Cookie", cookie).expect(400);
    await http().get(`/admin/competitions/${COMPETITION_ID}/matches/list?category=Men%20-58kg`).set("Cookie", cookie).expect(200);
    expect(matches.listCategory).toHaveBeenCalledWith(COMPETITION_ID, "Men -58kg");
    await http().get(`/admin/competitions/${COMPETITION_ID}/matches/list?uncategorized=true`).set("Cookie", cookie).expect(200);
    expect(matches.listCategory).toHaveBeenCalledWith(COMPETITION_ID, null);
  });
});
