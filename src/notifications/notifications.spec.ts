import "dotenv/config";
import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";
import { NotificationsRepository } from "./notifications.repository";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

// Test d'intégration HTTP contre la vraie base Postgres locale (même
// convention que coach-training-attendance.spec.ts) : GET /notifications,
// GET /notifications/unread-count, PATCH /notifications/:id/read, PATCH
// /notifications/read-all — recipient_user_id TOUJOURS dérivé de
// req.user.sub (JwtAuthGuard), jamais d'un id client (ticket "SECURITY").
// Aucun endpoint de création : les lignes sont insérées directement en base
// pour ces tests, comme le ferait un service métier coach (voir
// notification-producers.spec.ts pour les flux de création réels).
describe("NotificationsController (HTTP, intégration Postgres)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const runId = Date.now();
  const createdUserIds: string[] = [];
  let counter = 0;

  beforeAll(async () => {
    prisma = new PrismaService();

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [NotificationsController],
      providers: [
        NotificationsService,
        NotificationsRepository,
        { provide: PrismaService, useValue: prisma },
        JwtAuthGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();
  }, 30000);

  afterEach(async () => {
    if (createdUserIds.length > 0) {
      await prisma.app_user.deleteMany({ where: { id: { in: createdUserIds } } });
      createdUserIds.length = 0;
    }
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  }, 30000);

  async function makeUser(): Promise<string> {
    counter += 1;
    const user = await prisma.app_user.create({
      data: { email: `test-notif-user-${runId}-${counter}@test.fr`, nom: "Test", prenom: `U${counter}` },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  async function makeNotification(
    recipientUserId: string,
    overrides: Partial<{
      actor_user_id: string | null;
      context: string;
      type: string;
      title: string;
      message: string | null;
      is_read: boolean;
      created_at: Date;
    }> = {},
  ) {
    return prisma.notification.create({
      data: {
        recipient_user_id: recipientUserId,
        context: "ATHLETE",
        type: "TRAINING_ASSIGNED",
        title: `Notif ${runId}`,
        ...overrides,
      },
    });
  }

  function cookieFor(userId: string): string {
    return authCookieHeader(signTestToken({ sub: userId }));
  }

  it("sans authentification -> 401", async () => {
    await request(app.getHttpServer()).get("/notifications").expect(401);
  });

  it("un user ne voit QUE ses propres notifications (isolation stricte)", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    await makeNotification(userA, { title: "Pour A 1" });
    await makeNotification(userA, { title: "Pour A 2" });
    await makeNotification(userB, { title: "Pour B" });

    const res = await request(app.getHttpServer()).get("/notifications").set("Cookie", cookieFor(userA)).expect(200);

    expect(res.body.total).toBe(2);
    expect(res.body.items.map((n: { title: string }) => n.title).sort()).toEqual(["Pour A 1", "Pour A 2"].sort());
  });

  it("tri created_at DESC (la plus récente en premier)", async () => {
    const user = await makeUser();
    await makeNotification(user, { title: "Ancienne", created_at: new Date("2026-01-01T00:00:00.000Z") });
    await makeNotification(user, { title: "Récente", created_at: new Date("2026-06-01T00:00:00.000Z") });
    await makeNotification(user, { title: "Milieu", created_at: new Date("2026-03-01T00:00:00.000Z") });

    const res = await request(app.getHttpServer()).get("/notifications").set("Cookie", cookieFor(user)).expect(200);

    expect(res.body.items.map((n: { title: string }) => n.title)).toEqual(["Récente", "Milieu", "Ancienne"]);
  });

  it("pagination page/limit (défaut 20, comportement identique à GET /competitions)", async () => {
    const user = await makeUser();
    for (let i = 0; i < 25; i++) {
      await makeNotification(user, { title: `N${i}`, created_at: new Date(Date.now() - i * 1000) });
    }

    const page1 = await request(app.getHttpServer()).get("/notifications?page=1&limit=20").set("Cookie", cookieFor(user)).expect(200);
    expect(page1.body.items).toHaveLength(20);
    expect(page1.body.total).toBe(25);
    expect(page1.body.page).toBe(1);
    expect(page1.body.limit).toBe(20);

    const page2 = await request(app.getHttpServer()).get("/notifications?page=2&limit=20").set("Cookie", cookieFor(user)).expect(200);
    expect(page2.body.items).toHaveLength(5);
  });

  it("limit > 50 -> 400 (max imposé par le service, même politique que /competitions)", async () => {
    const user = await makeUser();
    await request(app.getHttpServer()).get("/notifications?limit=51").set("Cookie", cookieFor(user)).expect(400);
  });

  it("context invalide -> 400", async () => {
    const user = await makeUser();
    await request(app.getHttpServer()).get("/notifications?context=INVALID").set("Cookie", cookieFor(user)).expect(400);
  });

  it("filtre ?context=ATHLETE exclut les notifications COACH du même user (compte hybride)", async () => {
    const user = await makeUser();
    await makeNotification(user, { title: "Vue athlète", context: "ATHLETE" });
    await makeNotification(user, { title: "Vue coach", context: "COACH" });

    const res = await request(app.getHttpServer()).get("/notifications?context=ATHLETE").set("Cookie", cookieFor(user)).expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.items[0].title).toBe("Vue athlète");
  });

  it("GET /notifications/unread-count ne compte que les non lues du user courant", async () => {
    const user = await makeUser();
    const other = await makeUser();
    await makeNotification(user, { is_read: false });
    await makeNotification(user, { is_read: false });
    await makeNotification(user, { is_read: true });
    await makeNotification(other, { is_read: false });

    const res = await request(app.getHttpServer()).get("/notifications/unread-count").set("Cookie", cookieFor(user)).expect(200);
    expect(res.body).toEqual({ count: 2 });
  });

  it("PATCH /notifications/:id/read marque lue (is_read + read_at), ownership stricte (autre user -> 404)", async () => {
    const owner = await makeUser();
    const intruder = await makeUser();
    const notif = await makeNotification(owner, { is_read: false });

    await request(app.getHttpServer())
      .patch(`/notifications/${notif.id}/read`)
      .set("Cookie", cookieFor(intruder))
      .expect(404);

    const stillUnread = await prisma.notification.findUnique({ where: { id: notif.id } });
    expect(stillUnread?.is_read).toBe(false);

    await request(app.getHttpServer()).patch(`/notifications/${notif.id}/read`).set("Cookie", cookieFor(owner)).expect(200);

    const updated = await prisma.notification.findUnique({ where: { id: notif.id } });
    expect(updated?.is_read).toBe(true);
    expect(updated?.read_at).not.toBeNull();
  });

  it("notification inexistante -> 404 (jamais un recipientUserId envoyé par le client)", async () => {
    const user = await makeUser();
    await request(app.getHttpServer())
      .patch("/notifications/00000000-0000-4000-8000-000000000000/read")
      .set("Cookie", cookieFor(user))
      .expect(404);
  });

  it("PATCH /notifications/read-all marque toutes les non-lues du user courant, jamais celles d'un autre user", async () => {
    const user = await makeUser();
    const other = await makeUser();
    await makeNotification(user, { is_read: false });
    await makeNotification(user, { is_read: false });
    await makeNotification(user, { is_read: true }); // déjà lue, comptée à part
    const otherNotif = await makeNotification(other, { is_read: false });

    const res = await request(app.getHttpServer()).patch("/notifications/read-all").set("Cookie", cookieFor(user)).expect(200);
    expect(res.body).toEqual({ updated: 2 });

    const remainingUnread = await prisma.notification.count({ where: { recipient_user_id: user, is_read: false } });
    expect(remainingUnread).toBe(0);

    const otherStillUnread = await prisma.notification.findUnique({ where: { id: otherNotif.id } });
    expect(otherStillUnread?.is_read).toBe(false); // jamais touché
  });

  it("read-all respecte ?context= (ne marque que le contexte demandé)", async () => {
    const user = await makeUser();
    await makeNotification(user, { context: "ATHLETE", is_read: false });
    const coachNotif = await makeNotification(user, { context: "COACH", is_read: false });

    await request(app.getHttpServer()).patch("/notifications/read-all?context=ATHLETE").set("Cookie", cookieFor(user)).expect(200);

    const coachStillUnread = await prisma.notification.findUnique({ where: { id: coachNotif.id } });
    expect(coachStillUnread?.is_read).toBe(false);
  });
});
