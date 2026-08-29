import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { CoachCompetitionPreparationsController } from "./coach-competition-preparations.controller";
import { CoachCompetitionPreparationsService } from "./coach-competition-preparations.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGuard } from "../auth/coach.guard";
import { CoachPreparationOwnershipGuard } from "../auth/coach-preparation-ownership.guard";
import { PrismaService } from "../prisma/prisma.service";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

describe("CoachCompetitionPreparationsController (HTTP)", () => {
  let app: INestApplication;
  let service: { createPreparation: jest.Mock; updatePreparation: jest.Mock; deletePreparation: jest.Mock };
  let prisma: { coach_competition_preparation: { findUnique: jest.Mock } };

  const COACH_ID = "c0ffee00-0000-4000-8000-000000000001";
  const COMPETITION_ID = "cccc1111-0000-4000-8000-000000000001";
  const PREPARATION_ID = "ddddaaaa-0000-4000-8000-000000000001";
  const ATHLETE_ID = "a1a1a1a1-0000-4000-8000-000000000001";

  let coachCookie: string;
  let athleteOnlyCookie: string;

  beforeEach(async () => {
    service = { createPreparation: jest.fn(), updatePreparation: jest.fn(), deletePreparation: jest.fn() };
    prisma = { coach_competition_preparation: { findUnique: jest.fn() } };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [CoachCompetitionPreparationsController],
      providers: [
        { provide: CoachCompetitionPreparationsService, useValue: service },
        { provide: PrismaService, useValue: prisma },
        JwtAuthGuard,
        CoachGuard,
        CoachPreparationOwnershipGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();

    coachCookie = authCookieHeader(signTestToken({ sub: "u-coach", coachId: COACH_ID }));
    athleteOnlyCookie = authCookieHeader(signTestToken({ sub: "u-athlete", athleteId: "a-anything" }));
  });

  afterEach(async () => {
    await app.close();
  });

  describe(`POST /coach/competitions/:competitionId/preparations`, () => {
    it("sans authentification -> 401", async () => {
      await request(app.getHttpServer())
        .post(`/coach/competitions/${COMPETITION_ID}/preparations`)
        .send({ athleteId: ATHLETE_ID })
        .expect(401);
    });

    it("athlete-only -> 403", async () => {
      await request(app.getHttpServer())
        .post(`/coach/competitions/${COMPETITION_ID}/preparations`)
        .set("Cookie", athleteOnlyCookie)
        .send({ athleteId: ATHLETE_ID })
        .expect(403);
      expect(service.createPreparation).not.toHaveBeenCalled();
    });

    it("athleteId manquant -> 400", async () => {
      await request(app.getHttpServer())
        .post(`/coach/competitions/${COMPETITION_ID}/preparations`)
        .set("Cookie", coachCookie)
        .send({})
        .expect(400);
      expect(service.createPreparation).not.toHaveBeenCalled();
    });

    it("status hors liste contrôlée -> 400", async () => {
      await request(app.getHttpServer())
        .post(`/coach/competitions/${COMPETITION_ID}/preparations`)
        .set("Cookie", coachCookie)
        .send({ athleteId: ATHLETE_ID, status: "qualifie" })
        .expect(400);
      expect(service.createPreparation).not.toHaveBeenCalled();
    });

    // Ticket §30 : coachId spoofé dans le body -> ignoré/refusé. Le DTO ne
    // déclare pas ce champ, ValidationPipe({forbidNonWhitelisted:true})
    // rejette la requête entière plutôt que de silencieusement l'ignorer.
    it("coachId injecté dans le body -> 400 (champ non déclaré par le DTO, jamais lu depuis le body)", async () => {
      await request(app.getHttpServer())
        .post(`/coach/competitions/${COMPETITION_ID}/preparations`)
        .set("Cookie", coachCookie)
        .send({ athleteId: ATHLETE_ID, coachId: "c0ffee00-0000-4000-8000-000000000009" })
        .expect(400);
      expect(service.createPreparation).not.toHaveBeenCalled();
    });

    it("coach valide -> 201", async () => {
      service.createPreparation.mockResolvedValue({ id: PREPARATION_ID, athleteId: ATHLETE_ID, competitionId: COMPETITION_ID, status: "envisage" });

      const res = await request(app.getHttpServer())
        .post(`/coach/competitions/${COMPETITION_ID}/preparations`)
        .set("Cookie", coachCookie)
        .send({ athleteId: ATHLETE_ID, objective: "Podium" })
        .expect(201);

      expect(res.body.id).toBe(PREPARATION_ID);
      expect(service.createPreparation).toHaveBeenCalledWith(
        COACH_ID,
        COMPETITION_ID,
        expect.objectContaining({ athleteId: ATHLETE_ID, objective: "Podium" }),
      );
    });
  });

  describe(`PATCH /coach/competitions/:competitionId/preparations/:preparationId (CoachPreparationOwnershipGuard)`, () => {
    it("préparation inconnue -> 403 (jamais 404)", async () => {
      prisma.coach_competition_preparation.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        .patch(`/coach/competitions/${COMPETITION_ID}/preparations/${PREPARATION_ID}`)
        .set("Cookie", coachCookie)
        .send({ status: "selectionne" })
        .expect(403);
      expect(service.updatePreparation).not.toHaveBeenCalled();
    });

    it("préparation d'un autre coach -> 403", async () => {
      prisma.coach_competition_preparation.findUnique.mockResolvedValue({ coach_id: "c0ffee00-0000-4000-8000-000000000009" });
      await request(app.getHttpServer())
        .patch(`/coach/competitions/${COMPETITION_ID}/preparations/${PREPARATION_ID}`)
        .set("Cookie", coachCookie)
        .send({ status: "selectionne" })
        .expect(403);
      expect(service.updatePreparation).not.toHaveBeenCalled();
    });

    // Ticket §18 : athleteId impossible à envoyer pour déplacer une
    // préparation existante — le DTO d'update ne déclare pas ce champ.
    it("athleteId dans le body d'update -> 400 (champ non déclaré, déplacement impossible)", async () => {
      prisma.coach_competition_preparation.findUnique.mockResolvedValue({ coach_id: COACH_ID });
      await request(app.getHttpServer())
        .patch(`/coach/competitions/${COMPETITION_ID}/preparations/${PREPARATION_ID}`)
        .set("Cookie", coachCookie)
        .send({ athleteId: "a-autre-athlete" })
        .expect(400);
      expect(service.updatePreparation).not.toHaveBeenCalled();
    });

    it("coach propriétaire -> 200", async () => {
      prisma.coach_competition_preparation.findUnique.mockResolvedValue({ coach_id: COACH_ID });
      service.updatePreparation.mockResolvedValue({ id: PREPARATION_ID, status: "selectionne" });

      const res = await request(app.getHttpServer())
        .patch(`/coach/competitions/${COMPETITION_ID}/preparations/${PREPARATION_ID}`)
        .set("Cookie", coachCookie)
        .send({ status: "selectionne" })
        .expect(200);

      expect(res.body.status).toBe("selectionne");
      expect(service.updatePreparation).toHaveBeenCalledWith(PREPARATION_ID, expect.objectContaining({ status: "selectionne" }));
    });
  });

  describe(`DELETE /coach/competitions/:competitionId/preparations/:preparationId (CoachPreparationOwnershipGuard)`, () => {
    it("préparation d'un autre coach -> 403", async () => {
      prisma.coach_competition_preparation.findUnique.mockResolvedValue({ coach_id: "c0ffee00-0000-4000-8000-000000000009" });
      await request(app.getHttpServer())
        .delete(`/coach/competitions/${COMPETITION_ID}/preparations/${PREPARATION_ID}`)
        .set("Cookie", coachCookie)
        .expect(403);
      expect(service.deletePreparation).not.toHaveBeenCalled();
    });

    it("coach propriétaire -> 204", async () => {
      prisma.coach_competition_preparation.findUnique.mockResolvedValue({ coach_id: COACH_ID });
      service.deletePreparation.mockResolvedValue(undefined);

      await request(app.getHttpServer())
        .delete(`/coach/competitions/${COMPETITION_ID}/preparations/${PREPARATION_ID}`)
        .set("Cookie", coachCookie)
        .expect(204);

      expect(service.deletePreparation).toHaveBeenCalledWith(PREPARATION_ID);
    });
  });
});
