import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { AthletesController } from "./athletes.controller";
import { AthletesService } from "./athletes.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AthleteOwnershipGuard } from "../auth/athlete-ownership.guard";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

// GET /athletes/:id est protégé (auth + ownership). POST /athletes (création
// publique sans invitation) a été retiré (voir ticket "Clubs, invitations &
// inscription Athlete contrôlée V1" §"SUPPRIMER L'INSCRIPTION ATHLETE
// LIBRE") : seul POST /auth/register (avec invitation valide) crée un
// athlete désormais.
describe("AthletesController (HTTP)", () => {
  let app: INestApplication;
  let service: { create: jest.Mock; findOne: jest.Mock };

  const VALID_ATHLETE_ID = "240fe60f-6e74-46ea-87a0-45872bd1f4fe";
  const OTHER_ATHLETE_ID = "aaaaaaaa-1111-4111-8111-111111111111";

  let authCookie: string;
  let otherAthleteAuthCookie: string;

  beforeEach(async () => {
    service = { create: jest.fn(), findOne: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [AthletesController],
      providers: [
        { provide: AthletesService, useValue: service },
        JwtAuthGuard,
        AthleteOwnershipGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    authCookie = authCookieHeader(
      signTestToken({ sub: "user-1", athleteId: VALID_ATHLETE_ID }),
    );
    otherAthleteAuthCookie = authCookieHeader(
      signTestToken({ sub: "user-2", athleteId: OTHER_ATHLETE_ID }),
    );
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /athletes n'existe plus (ancien endpoint libre inutilisable)", async () => {
    await request(app.getHttpServer())
      .post("/athletes")
      .send({ email: "test@test.fr", nom: "Test", prenom: "Athlete" })
      .expect(404);

    expect(service.create).not.toHaveBeenCalled();
  });

  it("GET /athletes/:id sans authentification -> 401", async () => {
    await request(app.getHttpServer()).get(`/athletes/${VALID_ATHLETE_ID}`).expect(401);
    expect(service.findOne).not.toHaveBeenCalled();
  });

  it("GET /athletes/:id avec le token d'un autre athlète -> 403", async () => {
    await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}`)
      .set("Cookie", otherAthleteAuthCookie)
      .expect(403);
    expect(service.findOne).not.toHaveBeenCalled();
  });

  it("GET /athletes/:id avec le bon athlète authentifié -> 200", async () => {
    service.findOne.mockResolvedValue({ id: VALID_ATHLETE_ID, app_user: { email: "test@test.fr" } });

    const res = await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}`)
      .set("Cookie", authCookie)
      .expect(200);

    expect(res.body.id).toBe(VALID_ATHLETE_ID);
    expect(service.findOne).toHaveBeenCalledWith(VALID_ATHLETE_ID);
  });
});
