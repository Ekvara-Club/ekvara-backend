import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { CoachGroupsController } from "./coach-groups.controller";
import { CoachGroupsService } from "./coach-groups.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGuard } from "../auth/coach.guard";
import { CoachGroupOwnershipGuard } from "../auth/coach-group-ownership.guard";
import { CoachAthleteAccessGuard } from "../auth/coach-athlete-access.guard";
import { PrismaService } from "../prisma/prisma.service";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

describe("CoachGroupsController (HTTP)", () => {
  let app: INestApplication;
  let service: {
    createGroup: jest.Mock;
    listGroups: jest.Mock;
    getGroupDetail: jest.Mock;
    renameGroup: jest.Mock;
    deleteGroup: jest.Mock;
    addAthlete: jest.Mock;
    removeAthlete: jest.Mock;
  };
  let prisma: { coach_group: { findUnique: jest.Mock }; coach_athlete: { findUnique: jest.Mock } };

  const COACH_ID = "c0ffee00-0000-4000-8000-000000000001";
  const OTHER_COACH_ID = "c0ffee00-0000-4000-8000-000000000009";
  const GROUP_ID = "9999aaaa-0000-4000-8000-000000000001";
  const ATHLETE_ID = "a1a1a1a1-0000-4000-8000-000000000001";

  let coachCookie: string;
  let athleteOnlyCookie: string;

  beforeEach(async () => {
    service = {
      createGroup: jest.fn(),
      listGroups: jest.fn(),
      getGroupDetail: jest.fn(),
      renameGroup: jest.fn(),
      deleteGroup: jest.fn(),
      addAthlete: jest.fn(),
      removeAthlete: jest.fn(),
    };
    prisma = { coach_group: { findUnique: jest.fn() }, coach_athlete: { findUnique: jest.fn() } };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [CoachGroupsController],
      providers: [
        { provide: CoachGroupsService, useValue: service },
        { provide: PrismaService, useValue: prisma },
        JwtAuthGuard,
        CoachGuard,
        CoachGroupOwnershipGuard,
        CoachAthleteAccessGuard,
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

  describe("POST /coach/groups", () => {
    it("athlete-only -> 403", async () => {
      await request(app.getHttpServer())
        .post("/coach/groups")
        .set("Cookie", athleteOnlyCookie)
        .send({ name: "Élite" })
        .expect(403);
    });

    it("nom vide -> 400", async () => {
      await request(app.getHttpServer())
        .post("/coach/groups")
        .set("Cookie", coachCookie)
        .send({ name: "" })
        .expect(400);
      expect(service.createGroup).not.toHaveBeenCalled();
    });

    it("coach valide -> 201", async () => {
      service.createGroup.mockResolvedValue({ id: GROUP_ID, name: "Élite", athleteCount: 0 });

      const res = await request(app.getHttpServer())
        .post("/coach/groups")
        .set("Cookie", coachCookie)
        .send({ name: "Élite" })
        .expect(201);

      expect(res.body).toEqual({ id: GROUP_ID, name: "Élite", athleteCount: 0 });
      expect(service.createGroup).toHaveBeenCalledWith(COACH_ID, "Élite");
    });
  });

  describe("Routes /coach/groups/:groupId (CoachGroupOwnershipGuard)", () => {
    it("groupe inconnu -> 403 (jamais 404, pas de fuite d'existence)", async () => {
      prisma.coach_group.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .get(`/coach/groups/${GROUP_ID}`)
        .set("Cookie", coachCookie)
        .expect(403);
      expect(service.getGroupDetail).not.toHaveBeenCalled();
    });

    it("groupe appartenant à un autre coach -> 403", async () => {
      prisma.coach_group.findUnique.mockResolvedValue({ coach_id: OTHER_COACH_ID });

      await request(app.getHttpServer())
        .get(`/coach/groups/${GROUP_ID}`)
        .set("Cookie", coachCookie)
        .expect(403);
      expect(service.getGroupDetail).not.toHaveBeenCalled();
    });

    it("groupe du coach connecté -> 200", async () => {
      prisma.coach_group.findUnique.mockResolvedValue({ coach_id: COACH_ID });
      service.getGroupDetail.mockResolvedValue({ id: GROUP_ID, name: "Élite", athletes: [] });

      const res = await request(app.getHttpServer())
        .get(`/coach/groups/${GROUP_ID}`)
        .set("Cookie", coachCookie)
        .expect(200);

      expect(res.body).toEqual({ id: GROUP_ID, name: "Élite", athletes: [] });
    });

    it("PATCH rename sur groupe d'un autre coach -> 403", async () => {
      prisma.coach_group.findUnique.mockResolvedValue({ coach_id: OTHER_COACH_ID });

      await request(app.getHttpServer())
        .patch(`/coach/groups/${GROUP_ID}`)
        .set("Cookie", coachCookie)
        .send({ name: "Nouveau nom" })
        .expect(403);
      expect(service.renameGroup).not.toHaveBeenCalled();
    });

    it("DELETE sur groupe du coach connecté -> 204", async () => {
      prisma.coach_group.findUnique.mockResolvedValue({ coach_id: COACH_ID });
      service.deleteGroup.mockResolvedValue(undefined);

      await request(app.getHttpServer())
        .delete(`/coach/groups/${GROUP_ID}`)
        .set("Cookie", coachCookie)
        .expect(204);

      expect(service.deleteGroup).toHaveBeenCalledWith(GROUP_ID);
    });
  });

  describe("POST /coach/groups/:groupId/athletes/:athleteId (double guard)", () => {
    it("groupe d'un autre coach -> 403, jamais atteindre CoachAthleteAccessGuard", async () => {
      prisma.coach_group.findUnique.mockResolvedValue({ coach_id: OTHER_COACH_ID });

      await request(app.getHttpServer())
        .post(`/coach/groups/${GROUP_ID}/athletes/${ATHLETE_ID}`)
        .set("Cookie", coachCookie)
        .expect(403);
      expect(prisma.coach_athlete.findUnique).not.toHaveBeenCalled();
      expect(service.addAthlete).not.toHaveBeenCalled();
    });

    it("groupe du coach mais athlete non assigné (coach_athlete absent) -> 403 (ticket §25)", async () => {
      prisma.coach_group.findUnique.mockResolvedValue({ coach_id: COACH_ID });
      prisma.coach_athlete.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .post(`/coach/groups/${GROUP_ID}/athletes/${ATHLETE_ID}`)
        .set("Cookie", coachCookie)
        .expect(403);
      expect(service.addAthlete).not.toHaveBeenCalled();
    });

    it("groupe du coach + athlete assigné -> 201, délègue au service", async () => {
      prisma.coach_group.findUnique.mockResolvedValue({ coach_id: COACH_ID });
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      service.addAthlete.mockResolvedValue(undefined);

      await request(app.getHttpServer())
        .post(`/coach/groups/${GROUP_ID}/athletes/${ATHLETE_ID}`)
        .set("Cookie", coachCookie)
        .expect(201);

      expect(service.addAthlete).toHaveBeenCalledWith(GROUP_ID, ATHLETE_ID);
    });
  });

  describe("DELETE /coach/groups/:groupId/athletes/:athleteId", () => {
    it("groupe du coach + athlete assigné -> 204", async () => {
      prisma.coach_group.findUnique.mockResolvedValue({ coach_id: COACH_ID });
      prisma.coach_athlete.findUnique.mockResolvedValue({ id: "link-1" });
      service.removeAthlete.mockResolvedValue(undefined);

      await request(app.getHttpServer())
        .delete(`/coach/groups/${GROUP_ID}/athletes/${ATHLETE_ID}`)
        .set("Cookie", coachCookie)
        .expect(204);

      expect(service.removeAthlete).toHaveBeenCalledWith(GROUP_ID, ATHLETE_ID);
    });
  });

  describe("GET /coach/groups", () => {
    it("coach sans groupe -> 200 []", async () => {
      service.listGroups.mockResolvedValue([]);

      const res = await request(app.getHttpServer()).get("/coach/groups").set("Cookie", coachCookie).expect(200);

      expect(res.body).toEqual([]);
    });
  });
});
