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
import { AdminAthletesController } from "./admin-athletes.controller";
import { AdminAthletesService } from "./admin-athletes.service";

const ADMIN_ID = "0b6f3c1e-2a4d-4e5f-9a7b-1c2d3e4f5a6b";
const ATHLETE_ID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const CSRF = "csrf-de-test";

// Câblage HTTP réel (ValidationPipe identique à main.ts, AdminGuard réel) ;
// comportement du service couvert par la spec d'intégration Postgres.
describe("AdminAthletesController (HTTP)", () => {
  let app: INestApplication;
  let service: Record<"list" | "countries" | "previewCreate" | "create" | "getProfile" | "previewUpdate" | "update", jest.Mock>;
  let cookie: string;

  beforeEach(async () => {
    service = {
      list: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
      countries: jest.fn().mockResolvedValue({ countries: ["FRA"] }),
      previewCreate: jest.fn().mockResolvedValue({ data: {}, candidates: [], warnings: [] }),
      create: jest.fn().mockResolvedValue({ id: ATHLETE_ID }),
      getProfile: jest.fn().mockResolvedValue({ id: ATHLETE_ID }),
      previewUpdate: jest.fn().mockResolvedValue({ data: {}, changedFields: [], candidates: [], warnings: [] }),
      update: jest.fn().mockResolvedValue({ id: ATHLETE_ID }),
    };
    const adminJwt = createAdminJwtService(TEST_JWT_SECRET);
    const sessions = new InMemoryAdminSessions();
    cookie = adminTestCookie(adminJwt, sessions, ADMIN_ID, CSRF);
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminAthletesController],
      providers: [
        AdminGuard,
        { provide: AdminAthletesService, useValue: service },
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
  const post = (body: object) => http().post("/admin/athletes").set("Cookie", cookie).set(ADMIN_CSRF_HEADER, CSRF).send(body);

  it("sans session -> 401 ; écriture sans jeton CSRF -> 403 ; service jamais appelé", async () => {
    await http().get("/admin/athletes").expect(401);
    await http().post("/admin/athletes").send({ displayName: "X" }).expect(401);
    await http().post("/admin/athletes").set("Cookie", cookie).send({ displayName: "X" }).expect(403);
    await http().patch(`/admin/athletes/${ATHLETE_ID}`).set("Cookie", cookie).send({ gender: "male" }).expect(403);
    expect(service.create).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  it("lecture avec session, sans jeton CSRF -> 200", async () => {
    await http().get("/admin/athletes").set("Cookie", cookie).expect(200);
    await http().get("/admin/athletes/countries").set("Cookie", cookie).expect(200);
    await http().get(`/admin/athletes/${ATHLETE_ID}`).set("Cookie", cookie).expect(200);
  });

  it.each([
    ["nom manquant", {}],
    ["nom vide", { displayName: "   " }],
    ["code pays de 2 lettres", { displayName: "Kim", countryCode: "FR" }],
    ["code pays non alphabétique", { displayName: "Kim", countryCode: "F1A" }],
    ["genre inconnu de la convention", { displayName: "Kim", gender: "m" }],
    ["date au mauvais format", { displayName: "Kim", birthDate: "04/03/2001" }],
    ["champ inconnu (compte EKVARA)", { displayName: "Kim", userId: ADMIN_ID }],
  ])("validation : %s -> 400", async (_label, body) => {
    await post(body).expect(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it("normalisation : espaces du nom réduits, code pays en majuscules, champs vides -> null", async () => {
    await post({ displayName: "  KIM   Minsu ", countryCode: " kor ", gender: "", birthDate: "" }).expect(201);
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "KIM Minsu", countryCode: "KOR", gender: null, birthDate: null }),
      ADMIN_ID,
    );
  });

  it("liste : recherche, pays (majuscules), origine, pagination bornée", async () => {
    await http().get("/admin/athletes?search=kim&country=kor&origin=manual&page=2&limit=10").set("Cookie", cookie).expect(200);
    expect(service.list).toHaveBeenCalledWith(expect.objectContaining({ search: "kim", country: "KOR", origin: "manual", page: 2, limit: 10 }));
    await http().get("/admin/athletes?limit=100").set("Cookie", cookie).expect(400);
    await http().get("/admin/athletes?country=FRANCE").set("Cookie", cookie).expect(400);
  });

  it("modification : nom null refusé, identifiant non UUID refusé", async () => {
    const patch = (id: string, body: object) => http().patch(`/admin/athletes/${id}`).set("Cookie", cookie).set(ADMIN_CSRF_HEADER, CSRF).send(body);
    await patch(ATHLETE_ID, { displayName: null }).expect(400);
    await patch("abc", { gender: "female" }).expect(400);
    expect(service.update).not.toHaveBeenCalled();
  });
});
