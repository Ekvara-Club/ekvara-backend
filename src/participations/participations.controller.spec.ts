import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, INestApplication, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { ParticipationsController } from "./participations.controller";
import { ParticipationsService } from "./participations.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AthleteOwnershipGuard } from "../auth/athlete-ownership.guard";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

// Test au niveau HTTP (via supertest) plutôt qu'un simple appel direct au
// contrôleur : ParseUUIDPipe n'est appliqué que par le pipeline de requête réel
// de Nest, pas lors d'un appel direct de méthode.
describe("ParticipationsController (HTTP)", () => {
  let app: INestApplication;
  let service: {
    participate: jest.Mock;
    findAllForAthlete: jest.Mock;
    findNextForAthlete: jest.Mock;
    updateResult: jest.Mock;
  };

  const VALID_ATHLETE_ID = "240fe60f-6e74-46ea-87a0-45872bd1f4fe";
  const OTHER_ATHLETE_ID = "aaaaaaaa-1111-4111-8111-111111111111";
  const VALID_COMPETITION_ID = "d337932f-359b-4f5b-bab7-84a6f7cb8c94";

  let authCookie: string;
  let otherAthleteAuthCookie: string;

  beforeEach(async () => {
    service = {
      participate: jest.fn(),
      findAllForAthlete: jest.fn(),
      findNextForAthlete: jest.fn(),
      updateResult: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [ParticipationsController],
      providers: [
        { provide: ParticipationsService, useValue: service },
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

  it("POST .../participate sans authentification -> 401, service jamais appelé", async () => {
    await request(app.getHttpServer())
      .post(`/athletes/not-a-uuid/competitions/${VALID_COMPETITION_ID}/participate`)
      .send({})
      .expect(401);

    expect(service.participate).not.toHaveBeenCalled();
  });

  it("POST .../participate avec le token d'un autre athlète -> 403", async () => {
    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/competitions/${VALID_COMPETITION_ID}/participate`)
      .set("Cookie", otherAthleteAuthCookie)
      .send({})
      .expect(403);

    expect(service.participate).not.toHaveBeenCalled();
  });

  it("POST .../participate avec un competitionId invalide (athlète authentifié) -> 400", async () => {
    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/competitions/not-a-uuid/participate`)
      .set("Cookie", authCookie)
      .send({})
      .expect(400);

    expect(service.participate).not.toHaveBeenCalled();
  });

  it("POST .../participate valide délègue au service et renvoie 201 avec le body créé", async () => {
    service.participate.mockResolvedValue({ id: "p-1", statut: "inscrit" });

    const res = await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/competitions/${VALID_COMPETITION_ID}/participate`)
      .set("Cookie", authCookie)
      .send({ categoriePoids: "-74 kg", categorieAge: "senior" })
      .expect(201);

    expect(res.body).toEqual({ id: "p-1", statut: "inscrit" });
    expect(service.participate).toHaveBeenCalledWith(VALID_ATHLETE_ID, VALID_COMPETITION_ID, {
      categoriePoids: "-74 kg",
      categorieAge: "senior",
    });
  });

  it("GET .../competitions sans authentification -> 401", async () => {
    await request(app.getHttpServer()).get("/athletes/not-a-uuid/competitions").expect(401);
    expect(service.findAllForAthlete).not.toHaveBeenCalled();
  });

  it("GET .../competitions avec le token d'un autre athlète -> 403", async () => {
    await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/competitions`)
      .set("Cookie", otherAthleteAuthCookie)
      .expect(403);
    expect(service.findAllForAthlete).not.toHaveBeenCalled();
  });

  it("GET .../competitions valide -> 200", async () => {
    service.findAllForAthlete.mockResolvedValue([]);
    await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/competitions`)
      .set("Cookie", authCookie)
      .expect(200);
  });

  it("GET .../competitions/next sans authentification -> 401", async () => {
    await request(app.getHttpServer()).get("/athletes/not-a-uuid/competitions/next").expect(401);
    expect(service.findNextForAthlete).not.toHaveBeenCalled();
  });

  it("GET .../competitions/next valide renvoie null tel quel (200)", async () => {
    service.findNextForAthlete.mockResolvedValue(null);

    const res = await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/competitions/next`)
      .set("Cookie", authCookie)
      .expect(200);

    expect(res.body).toBeNull();
  });

  it("PATCH .../result sans authentification -> 401", async () => {
    await request(app.getHttpServer())
      .patch(`/athletes/not-a-uuid/competitions/${VALID_COMPETITION_ID}/result`)
      .send({ classement: 1 })
      .expect(401);
    expect(service.updateResult).not.toHaveBeenCalled();
  });

  it("PATCH .../result avec le token d'un autre athlète -> 403", async () => {
    await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/competitions/${VALID_COMPETITION_ID}/result`)
      .set("Cookie", otherAthleteAuthCookie)
      .send({ classement: 1 })
      .expect(403);
    expect(service.updateResult).not.toHaveBeenCalled();
  });

  it("PATCH .../result avec competitionId invalide (athlète authentifié) -> 400", async () => {
    await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/competitions/not-a-uuid/result`)
      .set("Cookie", authCookie)
      .send({ classement: 1 })
      .expect(400);
    expect(service.updateResult).not.toHaveBeenCalled();
  });

  it("PATCH .../result avec athleteId invalide -> 400", async () => {
    // AthleteOwnershipGuard s'exécute avant ParseUUIDPipe : pour atteindre
    // réellement le 400, le token doit porter le même athleteId invalide que
    // l'URL (cf. MetricsController pour le même cas déjà rencontré).
    const invalidAthleteIdCookie = authCookieHeader(
      signTestToken({ sub: "user-1", athleteId: "not-a-uuid" }),
    );

    await request(app.getHttpServer())
      .patch(`/athletes/not-a-uuid/competitions/${VALID_COMPETITION_ID}/result`)
      .set("Cookie", invalidAthleteIdCookie)
      .send({ classement: 1 })
      .expect(400);
    expect(service.updateResult).not.toHaveBeenCalled();
  });

  it("PATCH .../result avec classement 0 -> 400", async () => {
    await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/competitions/${VALID_COMPETITION_ID}/result`)
      .set("Cookie", authCookie)
      .send({ classement: 0 })
      .expect(400);
    expect(service.updateResult).not.toHaveBeenCalled();
  });

  it("PATCH .../result avec classement négatif -> 400", async () => {
    await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/competitions/${VALID_COMPETITION_ID}/result`)
      .set("Cookie", authCookie)
      .send({ classement: -1 })
      .expect(400);
    expect(service.updateResult).not.toHaveBeenCalled();
  });

  it("PATCH .../result avec classement décimal -> 400", async () => {
    await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/competitions/${VALID_COMPETITION_ID}/result`)
      .set("Cookie", authCookie)
      .send({ classement: 1.5 })
      .expect(400);
    expect(service.updateResult).not.toHaveBeenCalled();
  });

  it("PATCH .../result avec medaille invalide -> 400", async () => {
    await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/competitions/${VALID_COMPETITION_ID}/result`)
      .set("Cookie", authCookie)
      .send({ medaille: "platine" })
      .expect(400);
    expect(service.updateResult).not.toHaveBeenCalled();
  });

  it("PATCH .../result avec victoires négatives -> 400", async () => {
    await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/competitions/${VALID_COMPETITION_ID}/result`)
      .set("Cookie", authCookie)
      .send({ victoires: -1 })
      .expect(400);
    expect(service.updateResult).not.toHaveBeenCalled();
  });

  it("PATCH .../result avec defaites négatives -> 400", async () => {
    await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/competitions/${VALID_COMPETITION_ID}/result`)
      .set("Cookie", authCookie)
      .send({ defaites: -1 })
      .expect(400);
    expect(service.updateResult).not.toHaveBeenCalled();
  });

  it("PATCH .../result body vide accepté par le DTO (tous champs optionnels), rejeté par le service -> 400", async () => {
    service.updateResult.mockRejectedValue(
      new BadRequestException("Au moins un champ de résultat doit être fourni"),
    );

    await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/competitions/${VALID_COMPETITION_ID}/result`)
      .set("Cookie", authCookie)
      .send({})
      .expect(400);
    expect(service.updateResult).toHaveBeenCalledWith(VALID_ATHLETE_ID, VALID_COMPETITION_ID, {});
  });

  it("PATCH .../result valide délègue au service et renvoie 200 avec le body mis à jour", async () => {
    service.updateResult.mockResolvedValue({
      id: "p-1",
      statut: "inscrit",
      classement: 3,
      medaille: "bronze",
      victoires: 4,
      defaites: 1,
    });

    const res = await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/competitions/${VALID_COMPETITION_ID}/result`)
      .set("Cookie", authCookie)
      .send({ classement: 3, medaille: "bronze", victoires: 4, defaites: 1 })
      .expect(200);

    expect(res.body.classement).toBe(3);
    expect(service.updateResult).toHaveBeenCalledWith(VALID_ATHLETE_ID, VALID_COMPETITION_ID, {
      classement: 3,
      medaille: "bronze",
      victoires: 4,
      defaites: 1,
    });
  });

  it.each(["or", "argent", "bronze"])("PATCH .../result avec medaille '%s' -> 200, acceptée", async (medaille) => {
    service.updateResult.mockResolvedValue({ id: "p-1", statut: "inscrit", medaille });

    await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/competitions/${VALID_COMPETITION_ID}/result`)
      .set("Cookie", authCookie)
      .send({ medaille })
      .expect(200);

    expect(service.updateResult).toHaveBeenCalledWith(VALID_ATHLETE_ID, VALID_COMPETITION_ID, { medaille });
  });

  it("PATCH .../result avec medaille null -> 200, transmise telle quelle au service (retrait de médaille)", async () => {
    service.updateResult.mockResolvedValue({
      id: "p-1",
      statut: "inscrit",
      classement: 3,
      medaille: null,
      victoires: 3,
      defaites: 1,
    });

    const res = await request(app.getHttpServer())
      .patch(`/athletes/${VALID_ATHLETE_ID}/competitions/${VALID_COMPETITION_ID}/result`)
      .set("Cookie", authCookie)
      .send({ medaille: null })
      .expect(200);

    expect(res.body.medaille).toBeNull();
    expect(service.updateResult).toHaveBeenCalledWith(VALID_ATHLETE_ID, VALID_COMPETITION_ID, {
      medaille: null,
    });
  });
});
