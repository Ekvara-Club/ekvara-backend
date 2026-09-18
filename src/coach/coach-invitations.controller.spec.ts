import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { CoachInvitationsController } from "./coach-invitations.controller";
import { InvitationsService } from "../invitations/invitations.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGuard } from "../auth/coach.guard";
import { CoachInvitationOwnershipGuard } from "../auth/coach-invitation-ownership.guard";
import { PrismaService } from "../prisma/prisma.service";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

describe("CoachInvitationsController (HTTP)", () => {
  let app: INestApplication;
  let service: { createInvitation: jest.Mock; listInvitations: jest.Mock; revoke: jest.Mock };
  let prisma: { club_invitation: { findUnique: jest.Mock } };

  const COACH_ID = "c-1111-1111-1111-111111111111";
  let coachCookie: string;
  let athleteOnlyCookie: string;

  beforeEach(async () => {
    service = { createInvitation: jest.fn(), listInvitations: jest.fn(), revoke: jest.fn() };
    prisma = { club_invitation: { findUnique: jest.fn() } };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [CoachInvitationsController],
      providers: [
        { provide: InvitationsService, useValue: service },
        { provide: PrismaService, useValue: prisma },
        JwtAuthGuard,
        CoachGuard,
        CoachInvitationOwnershipGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();

    coachCookie = authCookieHeader(signTestToken({ sub: "u-coach", coachId: COACH_ID }));
    athleteOnlyCookie = authCookieHeader(
      signTestToken({ sub: "u-athlete-only", athleteId: "a-1111-1111-1111-111111111111" }),
    );
  });

  afterEach(async () => {
    await app.close();
  });

  describe("POST /coach/invitations", () => {
    it("sans authentification -> 401", async () => {
      await request(app.getHttpServer()).post("/coach/invitations").send({}).expect(401);
      expect(service.createInvitation).not.toHaveBeenCalled();
    });

    it("compte athlete-only (pas coachId) -> 403", async () => {
      await request(app.getHttpServer())
        .post("/coach/invitations")
        .set("Cookie", athleteOnlyCookie)
        .send({})
        .expect(403);
      expect(service.createInvitation).not.toHaveBeenCalled();
    });

    it("coach authentifié -> 201, code renvoyé une seule fois", async () => {
      service.createInvitation.mockResolvedValue({
        invitationId: "inv-1",
        code: "EKV-ABCD2345",
        expiresAt: new Date("2026-09-25T00:00:00.000Z"),
      });

      const res = await request(app.getHttpServer())
        .post("/coach/invitations")
        .set("Cookie", coachCookie)
        .send({})
        .expect(201);

      expect(res.body).toEqual({
        invitationId: "inv-1",
        code: "EKV-ABCD2345",
        expiresAt: "2026-09-25T00:00:00.000Z",
      });
      expect(service.createInvitation).toHaveBeenCalledWith(COACH_ID, undefined);
    });

    it("avec assignedGroupId -> transmis au service", async () => {
      const GROUP_ID = "22222222-2222-4222-8222-222222222222";
      service.createInvitation.mockResolvedValue({ invitationId: "inv-1", code: "EKV-ABCD2345", expiresAt: new Date() });

      await request(app.getHttpServer())
        .post("/coach/invitations")
        .set("Cookie", coachCookie)
        .send({ assignedGroupId: GROUP_ID })
        .expect(201);

      expect(service.createInvitation).toHaveBeenCalledWith(COACH_ID, GROUP_ID);
    });

    it("assignedGroupId malformé (pas un UUID) -> 400", async () => {
      await request(app.getHttpServer())
        .post("/coach/invitations")
        .set("Cookie", coachCookie)
        .send({ assignedGroupId: "pas-un-uuid" })
        .expect(400);
      expect(service.createInvitation).not.toHaveBeenCalled();
    });
  });

  describe("GET /coach/invitations", () => {
    it("sans authentification -> 401", async () => {
      await request(app.getHttpServer()).get("/coach/invitations").expect(401);
    });

    it("coach authentifié -> 200, jamais le code brut dans la liste", async () => {
      service.listInvitations.mockResolvedValue([
        { id: "inv-1", createdAt: new Date(), expiresAt: new Date(), usedAt: null, revokedAt: null, status: "active" },
      ]);

      const res = await request(app.getHttpServer())
        .get("/coach/invitations")
        .set("Cookie", coachCookie)
        .expect(200);

      expect(JSON.stringify(res.body)).not.toMatch(/EKV-/);
      expect(service.listInvitations).toHaveBeenCalledWith(COACH_ID);
    });
  });

  describe("PATCH /coach/invitations/:invitationId/revoke (CoachInvitationOwnershipGuard)", () => {
    const INVITATION_ID = "11111111-1111-4111-8111-111111111111";

    it("invitation inconnue -> 403 (jamais 404, pas de fuite d'existence)", async () => {
      prisma.club_invitation.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .patch(`/coach/invitations/${INVITATION_ID}/revoke`)
        .set("Cookie", coachCookie)
        .expect(403);
      expect(service.revoke).not.toHaveBeenCalled();
    });

    it("invitation d'un autre coach -> 403", async () => {
      prisma.club_invitation.findUnique.mockResolvedValue({ created_by_coach_id: "un-autre-coach" });

      await request(app.getHttpServer())
        .patch(`/coach/invitations/${INVITATION_ID}/revoke`)
        .set("Cookie", coachCookie)
        .expect(403);
      expect(service.revoke).not.toHaveBeenCalled();
    });

    it("propriétaire -> 200, révocation déléguée", async () => {
      prisma.club_invitation.findUnique.mockResolvedValue({ created_by_coach_id: COACH_ID });
      service.revoke.mockResolvedValue(undefined);

      const res = await request(app.getHttpServer())
        .patch(`/coach/invitations/${INVITATION_ID}/revoke`)
        .set("Cookie", coachCookie)
        .expect(200);

      expect(res.body).toEqual({ success: true });
      expect(service.revoke).toHaveBeenCalledWith(INVITATION_ID);
    });
  });
});
