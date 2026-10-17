import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { TEST_JWT_SECRET } from "../../test-utils/auth-test.helper";
import { AdminAuditLogger } from "../admin-audit.logger";
import { AdminGuard } from "../admin.guard";
import { ADMIN_COOKIE_NAME, ADMIN_CSRF_HEADER } from "../admin-session";
import { ADMIN_JWT, ADMIN_USER_IDS, createAdminJwtService } from "../admin-tokens";
import { AdminSessionsRepository } from "../admin-sessions.repository";
import { adminTestCookie, InMemoryAdminSessions } from "../../test-utils/admin-test.helper";
import { AdminCompetitionsController } from "./admin-competitions.controller";
import { AdminCompetitionsService } from "./admin-competitions.service";

const ADMIN_ID = "0b6f3c1e-2a4d-4e5f-9a7b-1c2d3e4f5a6b";
const COMPETITION_ID = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const CSRF = "csrf-de-test";

// Câblage HTTP réel (ValidationPipe global identique à main.ts, AdminGuard
// réel) ; le service est simulé : son comportement est couvert par la spec
// d'intégration Postgres.
describe("AdminCompetitionsController (HTTP)", () => {
  let app: INestApplication;
  let service: Record<"list" | "years" | "previewCreate" | "create" | "getDetail" | "previewUpdate" | "update", jest.Mock>;
  let cookie: string;

  beforeEach(async () => {
    service = {
      list: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
      years: jest.fn().mockResolvedValue({ years: [2026] }),
      previewCreate: jest.fn().mockResolvedValue({ data: {}, candidates: [], warnings: [] }),
      create: jest.fn().mockResolvedValue({ id: COMPETITION_ID }),
      getDetail: jest.fn().mockResolvedValue({ id: COMPETITION_ID }),
      previewUpdate: jest.fn().mockResolvedValue({ data: {}, changedFields: [], candidates: [], warnings: [] }),
      update: jest.fn().mockResolvedValue({ id: COMPETITION_ID }),
    };
    const adminJwt = createAdminJwtService(TEST_JWT_SECRET);
    const sessions = new InMemoryAdminSessions();
    cookie = adminTestCookie(adminJwt, sessions, ADMIN_ID, CSRF);

    const moduleRef = await Test.createTestingModule({
      controllers: [AdminCompetitionsController],
      providers: [
        AdminGuard,
        { provide: AdminCompetitionsService, useValue: service },
        { provide: AdminAuditLogger, useValue: { record: jest.fn(), denied: jest.fn() } },
        { provide: ADMIN_JWT, useValue: adminJwt },
        { provide: ADMIN_USER_IDS, useValue: new Set([ADMIN_ID]) },
        { provide: AdminSessionsRepository, useValue: sessions },
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
  const VALID = { nom: "Open Test", dateDebut: "2026-05-02" };

  describe("autorisation", () => {
    it("sans session admin -> 401 sur lecture comme écriture, service jamais appelé", async () => {
      await http().get("/admin/competitions").expect(401);
      await http().post("/admin/competitions").send(VALID).expect(401);
      expect(service.list).not.toHaveBeenCalled();
      expect(service.create).not.toHaveBeenCalled();
    });

    it("écriture sans jeton CSRF -> 403 (création, prévisualisation, modification)", async () => {
      await http().post("/admin/competitions").set("Cookie", cookie).send(VALID).expect(403);
      await http().post("/admin/competitions/preview").set("Cookie", cookie).send(VALID).expect(403);
      await http().patch(`/admin/competitions/${COMPETITION_ID}`).set("Cookie", cookie).send({ saison: "2026" }).expect(403);
      expect(service.create).not.toHaveBeenCalled();
      expect(service.update).not.toHaveBeenCalled();
    });

    it("lecture avec session -> 200 sans jeton CSRF", async () => {
      await http().get("/admin/competitions").set("Cookie", cookie).expect(200);
      await http().get("/admin/competitions/years").set("Cookie", cookie).expect(200);
      await http().get(`/admin/competitions/${COMPETITION_ID}`).set("Cookie", cookie).expect(200);
    });

    it("création authentifiée -> transmet l'identité admin au service", async () => {
      await http().post("/admin/competitions").set("Cookie", cookie).set(ADMIN_CSRF_HEADER, CSRF).send(VALID).expect(201);
      expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ nom: "Open Test", dateDebut: "2026-05-02" }), ADMIN_ID);
    });
  });

  describe("validation serveur", () => {
    const post = (body: object) => http().post("/admin/competitions").set("Cookie", cookie).set(ADMIN_CSRF_HEADER, CSRF).send(body);

    it.each([
      ["nom manquant", { dateDebut: "2026-05-02" }],
      ["nom vide", { nom: "   ", dateDebut: "2026-05-02" }],
      ["date de début manquante", { nom: "Open" }],
      ["date au mauvais format", { nom: "Open", dateDebut: "02/05/2026" }],
      ["date de fin au mauvais format", { ...VALID, dateFin: "demain" }],
      ["champ trop long", { ...VALID, ville: "x".repeat(101) }],
      ["champ inconnu", { ...VALID, source: "fftda" }],
      ["identifiant de doublon invalide", { ...VALID, acknowledgedDuplicateIds: ["pas-un-uuid"] }],
    ])("%s -> 400, rien n'est transmis au service", async (_label, body) => {
      await post(body).expect(400);
      expect(service.create).not.toHaveBeenCalled();
    });

    it("chaînes facultatives vides -> null (jamais une valeur inventée), espaces retirés", async () => {
      await post({ ...VALID, nom: "  Open Test  ", ville: "", pays: "  " }).expect(201);
      expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ nom: "Open Test", ville: null, pays: null }), ADMIN_ID);
    });

    it("modification : nom ou date de début null -> 400 ; identifiant non UUID -> 400", async () => {
      const patch = (id: string, body: object) =>
        http().patch(`/admin/competitions/${id}`).set("Cookie", cookie).set(ADMIN_CSRF_HEADER, CSRF).send(body);
      await patch(COMPETITION_ID, { nom: null }).expect(400);
      await patch(COMPETITION_ID, { dateDebut: null }).expect(400);
      await patch("abc", { saison: "2026" }).expect(400);
      expect(service.update).not.toHaveBeenCalled();
    });

    it("liste : paramètres convertis et bornés", async () => {
      await http().get("/admin/competitions?page=2&limit=10&year=2026&sort=asc&origin=manual&search=open").set("Cookie", cookie).expect(200);
      expect(service.list).toHaveBeenCalledWith(expect.objectContaining({ page: 2, limit: 10, year: 2026, sort: "asc", origin: "manual", search: "open" }));
      await http().get("/admin/competitions?limit=500").set("Cookie", cookie).expect(400);
      await http().get("/admin/competitions?sort=random").set("Cookie", cookie).expect(400);
      await http().get("/admin/competitions?origin=fftda").set("Cookie", cookie).expect(400);
    });
  });
});
