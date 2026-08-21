import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, INestApplication, NotFoundException, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { TrainingsController } from "./trainings.controller";
import { TrainingsService } from "./trainings.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AthleteOwnershipGuard } from "../auth/athlete-ownership.guard";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

// Test au niveau HTTP (via supertest) pour exercer réellement ParseUUIDPipe et le
// ValidationPipe global, pas seulement des appels directs au service.
describe("TrainingsController (HTTP)", () => {
  let app: INestApplication;
  let service: {
    createTraining: jest.Mock;
    findAllForAthlete: jest.Mock;
    findNextForAthlete: jest.Mock;
  };

  const VALID_ATHLETE_ID = "240fe60f-6e74-46ea-87a0-45872bd1f4fe";
  const OTHER_ATHLETE_ID = "aaaaaaaa-1111-4111-8111-111111111111";

  let authCookie: string;
  let otherAthleteAuthCookie: string;

  beforeEach(async () => {
    service = {
      createTraining: jest.fn(),
      findAllForAthlete: jest.fn(),
      findNextForAthlete: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [TrainingsController],
      providers: [
        { provide: TrainingsService, useValue: service },
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

  it("POST .../trainings sans authentification -> 401", async () => {
    await request(app.getHttpServer())
      .post("/athletes/not-a-uuid/trainings")
      .send({ title: "Séance", startAt: "2026-08-20T18:30:00.000Z" })
      .expect(401);
    expect(service.createTraining).not.toHaveBeenCalled();
  });

  it("POST .../trainings avec le token d'un autre athlète -> 403", async () => {
    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/trainings`)
      .set("Cookie", otherAthleteAuthCookie)
      .send({ title: "Séance", startAt: "2026-08-20T18:30:00.000Z" })
      .expect(403);
    expect(service.createTraining).not.toHaveBeenCalled();
  });

  it("POST .../trainings sans titre -> 400", async () => {
    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/trainings`)
      .set("Cookie", authCookie)
      .send({ startAt: "2026-08-20T18:30:00.000Z" })
      .expect(400);
    expect(service.createTraining).not.toHaveBeenCalled();
  });

  it("POST .../trainings avec startAt invalide -> 400", async () => {
    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/trainings`)
      .set("Cookie", authCookie)
      .send({ title: "Séance", startAt: "pas-une-date" })
      .expect(400);
    expect(service.createTraining).not.toHaveBeenCalled();
  });

  it("POST .../trainings avec date_fin <= date_debut -> 400 (délégué au service)", async () => {
    service.createTraining.mockRejectedValue(
      new BadRequestException("date_fin doit être strictement postérieure à date_debut"),
    );

    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/trainings`)
      .set("Cookie", authCookie)
      .send({
        title: "Séance",
        startAt: "2026-08-20T18:30:00.000Z",
        endAt: "2026-08-20T17:00:00.000Z",
      })
      .expect(400);
  });

  it("POST .../trainings avec athlète inexistant -> 404 (délégué au service)", async () => {
    service.createTraining.mockRejectedValue(new NotFoundException("Athlete introuvable"));

    await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/trainings`)
      .set("Cookie", authCookie)
      .send({ title: "Séance", startAt: "2026-08-20T18:30:00.000Z" })
      .expect(404);
  });

  it("POST .../trainings valide -> 201", async () => {
    service.createTraining.mockResolvedValue({
      id: "t1",
      title: "Taekwondo au club",
      type: "taekwondo",
      subType: "combat",
      startAt: new Date("2026-08-20T18:30:00.000Z"),
      endAt: new Date("2026-08-20T20:30:00.000Z"),
      location: "Arena Teddy Riner",
      level: "Elite",
      description: null,
      status: "prevu",
    });

    const res = await request(app.getHttpServer())
      .post(`/athletes/${VALID_ATHLETE_ID}/trainings`)
      .set("Cookie", authCookie)
      .send({
        title: "Taekwondo au club",
        type: "taekwondo",
        subType: "combat",
        startAt: "2026-08-20T18:30:00.000Z",
        endAt: "2026-08-20T20:30:00.000Z",
        location: "Arena Teddy Riner",
        level: "Elite",
      })
      .expect(201);

    expect(res.body.id).toBe("t1");
  });

  it("GET .../trainings sans authentification -> 401", async () => {
    await request(app.getHttpServer()).get("/athletes/not-a-uuid/trainings").expect(401);
  });

  it("GET .../trainings avec le token d'un autre athlète -> 403", async () => {
    await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/trainings`)
      .set("Cookie", otherAthleteAuthCookie)
      .expect(403);
  });

  it("GET .../trainings valide -> 200", async () => {
    service.findAllForAthlete.mockResolvedValue([]);
    await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/trainings`)
      .set("Cookie", authCookie)
      .expect(200);
  });

  it("GET .../trainings sans from ni to -> comportement inchangé (range undefined)", async () => {
    service.findAllForAthlete.mockResolvedValue([]);

    await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/trainings`)
      .set("Cookie", authCookie)
      .expect(200);

    expect(service.findAllForAthlete).toHaveBeenCalledWith(VALID_ATHLETE_ID, undefined);
  });

  it("GET .../trainings avec from et to valides -> délègue la plage au service", async () => {
    service.findAllForAthlete.mockResolvedValue([]);

    await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/trainings`)
      .set("Cookie", authCookie)
      .query({ from: "2026-08-17T00:00:00.000Z", to: "2026-08-23T23:59:59.999Z" })
      .expect(200);

    const [, range] = service.findAllForAthlete.mock.calls[0];
    expect(range.from.toISOString()).toBe("2026-08-17T00:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-08-23T23:59:59.999Z");
  });

  it("GET .../trainings avec from invalide -> 400", async () => {
    await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/trainings`)
      .set("Cookie", authCookie)
      .query({ from: "pas-une-date", to: "2026-08-23T23:59:59.999Z" })
      .expect(400);
    expect(service.findAllForAthlete).not.toHaveBeenCalled();
  });

  it("GET .../trainings avec seulement from (sans to) -> 400", async () => {
    await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/trainings`)
      .set("Cookie", authCookie)
      .query({ from: "2026-08-17T00:00:00.000Z" })
      .expect(400);
    expect(service.findAllForAthlete).not.toHaveBeenCalled();
  });

  it("GET .../trainings avec from > to -> 400", async () => {
    await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/trainings`)
      .set("Cookie", authCookie)
      .query({ from: "2026-08-23T00:00:00.000Z", to: "2026-08-17T00:00:00.000Z" })
      .expect(400);
    expect(service.findAllForAthlete).not.toHaveBeenCalled();
  });

  it("GET .../trainings/next sans authentification -> 401", async () => {
    await request(app.getHttpServer()).get("/athletes/not-a-uuid/trainings/next").expect(401);
  });

  it("GET .../trainings/next avec le token d'un autre athlète -> 403", async () => {
    await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/trainings/next`)
      .set("Cookie", otherAthleteAuthCookie)
      .expect(403);
  });

  it("GET .../trainings/next sans séance éligible -> 200 null", async () => {
    service.findNextForAthlete.mockResolvedValue(null);

    const res = await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/trainings/next`)
      .set("Cookie", authCookie)
      .expect(200);

    expect(res.body).toBeNull();
  });

  it("GET .../trainings/next avec séance -> 200", async () => {
    service.findNextForAthlete.mockResolvedValue({
      id: "t1",
      title: "Taekwondo au club",
      type: "taekwondo",
      subType: "combat",
      startAt: new Date("2026-08-20T18:30:00.000Z"),
      endAt: new Date("2026-08-20T20:30:00.000Z"),
      location: "Arena Teddy Riner",
      level: "Elite",
      description: null,
      status: "prevu",
    });

    const res = await request(app.getHttpServer())
      .get(`/athletes/${VALID_ATHLETE_ID}/trainings/next`)
      .set("Cookie", authCookie)
      .expect(200);

    expect(res.body.id).toBe("t1");
  });
});
