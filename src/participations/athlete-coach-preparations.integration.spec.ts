import "dotenv/config";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { PrismaService } from "../prisma/prisma.service";
import { CompetitionsRepository } from "../competitions/competitions.repository";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AthleteOwnershipGuard } from "../auth/athlete-ownership.guard";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";
import { ParticipationsController } from "./participations.controller";
import { ParticipationsService } from "./participations.service";
import { ParticipationsRepository } from "./participations.repository";

// Intégration de bout en bout (HTTP -> controller -> service -> repository ->
// vraie base Postgres locale) : la circulation coach -> athlète (visibilité,
// isolation, absence de note_coach dans le JSON réel) ne peut pas être validée
// sincèrement par des mocks. Données préfixées "test_fixture_athlete_prep" et
// intégralement nettoyées en afterAll ; aucune donnée réelle n'est touchée.
describe("Préparations coach visibles côté athlète (intégration HTTP + Postgres)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const runId = Date.now();
  const NOTE_A = `NOTE-SECRETE-COACH1-${runId}`;
  const NOTE_B = `NOTE-SECRETE-COACH2-${runId}`;
  const OBJECTIF = `OBJECTIF-SECRET-${runId}`;

  const userIds: string[] = [];
  const competitionIds: string[] = [];
  let athleteA: { id: string; userId: string };
  let athleteB: { id: string; userId: string };
  let coach1Id: string;
  let coach2Id: string;
  const comp: Record<"past" | "near" | "mid" | "far", string> = { past: "", near: "", mid: "", far: "" };

  const todayUtcMidnight = (() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  })();
  const daysFromToday = (offset: number) => new Date(todayUtcMidnight.getTime() + offset * 86_400_000);

  const cookieFor = (a: { id: string; userId: string }) =>
    authCookieHeader(signTestToken({ sub: a.userId, athleteId: a.id }));

  async function makeUser(label: string) {
    const user = await prisma.app_user.create({
      data: { email: `test-fixture-athlete-prep-${label}-${runId}@test.fr`, nom: label, prenom: "Fixture" },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function makeAthlete(label: string) {
    const userId = await makeUser(label);
    const athlete = await prisma.athlete.create({ data: { user_id: userId } });
    return { id: athlete.id, userId };
  }

  async function makeCoach(label: string) {
    const userId = await makeUser(label);
    return (await prisma.coach_profile.create({ data: { user_id: userId } })).id;
  }

  async function makeCompetition(key: keyof typeof comp, offset: number) {
    const c = await prisma.competition.create({
      data: {
        nom: `Fixture prep ${key} ${runId}`,
        date_debut: daysFromToday(offset),
        ville: "Eaubonne",
        pays: "France",
        sources: { create: { source: "test_fixture_athlete_prep", source_external_id: `${runId}-${key}` } },
      },
    });
    comp[key] = c.id;
    competitionIds.push(c.id);
  }

  const prep = (
    coachId: string,
    athleteId: string,
    competitionId: string,
    data: { statut?: string; age?: string | null; poids?: string | null; note?: string; objectif?: string },
  ) =>
    prisma.coach_competition_preparation.create({
      data: {
        coach_id: coachId,
        athlete_id: athleteId,
        competition_id: competitionId,
        statut: data.statut ?? "pret",
        categorie_age_prevue: data.age === undefined ? "Senior" : data.age,
        categorie_poids_prevue: data.poids === undefined ? "-68kg" : data.poids,
        note_coach: data.note,
        objectif: data.objectif,
      },
    });

  const next = (a: { id: string; userId: string }) =>
    request(app.getHttpServer()).get(`/athletes/${a.id}/competitions/next`).set("Cookie", cookieFor(a));
  const list = (a: { id: string; userId: string }) =>
    request(app.getHttpServer()).get(`/athletes/${a.id}/competitions/preparations`).set("Cookie", cookieFor(a));

  const cleanPreparations = () =>
    prisma.coach_competition_preparation.deleteMany({ where: { competition_id: { in: competitionIds } } });

  beforeAll(async () => {
    prisma = new PrismaService();

    athleteA = await makeAthlete("A");
    athleteB = await makeAthlete("B");
    coach1Id = await makeCoach("Coach1");
    coach2Id = await makeCoach("Coach2");
    await prisma.coach_athlete.createMany({
      data: [
        { coach_id: coach1Id, athlete_id: athleteA.id },
        { coach_id: coach2Id, athlete_id: athleteA.id },
        { coach_id: coach1Id, athlete_id: athleteB.id },
      ],
    });
    await makeCompetition("past", -10);
    await makeCompetition("near", 10);
    await makeCompetition("mid", 30);
    await makeCompetition("far", 60);

    const moduleRef = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [ParticipationsController],
      providers: [
        ParticipationsService,
        ParticipationsRepository,
        CompetitionsRepository,
        { provide: PrismaService, useValue: prisma },
        JwtAuthGuard,
        AthleteOwnershipGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();
  }, 30000);

  afterEach(async () => {
    await cleanPreparations();
    await prisma.participation.deleteMany({ where: { competition_id: { in: competitionIds } } });
  });

  afterAll(async () => {
    await app.close();
    await cleanPreparations();
    await prisma.participation.deleteMany({ where: { competition_id: { in: competitionIds } } });
    await prisma.coach_athlete.deleteMany({ where: { athlete_id: { in: [athleteA.id, athleteB.id] } } });
    await prisma.competition.deleteMany({ where: { id: { in: competitionIds } } });
    await prisma.coach_profile.deleteMany({ where: { id: { in: [coach1Id, coach2Id] } } });
    await prisma.athlete.deleteMany({ where: { id: { in: [athleteA.id, athleteB.id] } } });
    await prisma.app_user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }, 30000);

  it("1/5 : préparation future visible pour l'athlète concerné, avec catégories prévues (next + liste)", async () => {
    await prep(coach1Id, athleteA.id, comp.near, { statut: "pret" });

    const nextRes = await next(athleteA).expect(200);
    expect(nextRes.body).toMatchObject({
      source: "coach_preparation",
      participationId: null,
      statut: null,
      preparation: { status: "pret", categorieAgePrevue: "Senior", categoriePoidsPrevue: "-68kg" },
      competition: { id: comp.near, ville: "Eaubonne", pays: "France" },
    });

    const listRes = await list(athleteA).expect(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0]).toMatchObject({
      competitionId: comp.near,
      source: "coach_preparation",
      status: "pret",
      categorieAgePrevue: "Senior",
      categoriePoidsPrevue: "-68kg",
    });
  });

  it("2 : préparation d'un AUTRE athlète invisible (next, liste) ; aucun athleteId arbitraire lisible", async () => {
    await prep(coach1Id, athleteB.id, comp.near, {});

    expect((await next(athleteA).expect(200)).body).toBeNull();
    expect((await list(athleteA).expect(200)).body).toEqual([]);

    // A ne peut pas lire l'espace de B en changeant l'athleteId du chemin.
    await request(app.getHttpServer())
      .get(`/athletes/${athleteB.id}/competitions/preparations`)
      .set("Cookie", cookieFor(athleteA))
      .expect(403);
    await request(app.getHttpServer())
      .get(`/athletes/${athleteB.id}/competitions/next`)
      .set("Cookie", cookieFor(athleteA))
      .expect(403);
    await request(app.getHttpServer()).get(`/athletes/${athleteA.id}/competitions/preparations`).expect(401);
  });

  it("3 : note_coach / objectif ABSENTS de toute réponse Athlete (corps JSON brut)", async () => {
    await prep(coach1Id, athleteA.id, comp.near, { note: NOTE_A, objectif: OBJECTIF });
    await prep(coach2Id, athleteA.id, comp.mid, { note: NOTE_B, objectif: OBJECTIF });
    // Cas participation + préparation : la note ne fuit pas non plus via /next ni /competitions.
    await prisma.participation.create({ data: { athlete_id: athleteA.id, competition_id: comp.near } });

    for (const path of ["next", "preparations", ""]) {
      const res = await request(app.getHttpServer())
        .get(`/athletes/${athleteA.id}/competitions/${path}`)
        .set("Cookie", cookieFor(athleteA))
        .expect(200);

      expect(res.text).not.toContain(NOTE_A);
      expect(res.text).not.toContain(NOTE_B);
      expect(res.text).not.toContain(OBJECTIF);
      expect(res.text).not.toMatch(/note_coach|coachNote|"objectif"|objective|coach_id|coachId/);
    }
  });

  it("4 : participation seule -> next inchangé (source participation)", async () => {
    await prisma.participation.create({ data: { athlete_id: athleteA.id, competition_id: comp.mid } });

    const res = await next(athleteA).expect(200);
    expect(res.body).toMatchObject({ source: "participation", statut: "inscrit", preparation: null, competition: { id: comp.mid } });
    expect(res.body.participationId).toEqual(expect.any(String));
  });

  it("6 : participation + préparation sur la même compétition -> UN résultat, participation prime, non falsifiée", async () => {
    await prisma.participation.create({
      data: { athlete_id: athleteA.id, competition_id: comp.near, categorie_poids: "-74 kg", categorie_age: "cadet" },
    });
    await prep(coach1Id, athleteA.id, comp.near, { statut: "pret", poids: "-68kg" });

    const res = await next(athleteA).expect(200);
    expect(res.body).toMatchObject({
      source: "participation",
      statut: "inscrit",
      categoriePoids: "-74 kg",
      categorieAge: "cadet",
      preparation: { status: "pret", categoriePoidsPrevue: "-68kg" },
      competition: { id: comp.near },
    });

    // "Mes compétitions" (GET /) reste PARTICIPATION-ONLY : une seule ligne, catégories officielles.
    const all = await request(app.getHttpServer())
      .get(`/athletes/${athleteA.id}/competitions`)
      .set("Cookie", cookieFor(athleteA))
      .expect(200);
    expect(all.body).toHaveLength(1);
    expect(all.body[0]).toMatchObject({ statut: "inscrit", categoriePoids: "-74 kg" });
  });

  it("7 : plusieurs compétitions -> la prochaine par date (préparation la plus proche ; forfait/passée ignorées)", async () => {
    await prep(coach1Id, athleteA.id, comp.far, { statut: "selectionne" });
    await prep(coach1Id, athleteA.id, comp.mid, { statut: "pret" });
    await prep(coach1Id, athleteA.id, comp.past, { statut: "pret" });

    const res = await next(athleteA).expect(200);
    expect(res.body.competition.id).toBe(comp.mid);
  });

  it("8 : compétition passée jamais utilisée comme next (mais présente dans la liste, pour le détail)", async () => {
    await prep(coach1Id, athleteA.id, comp.past, { statut: "pret" });

    expect((await next(athleteA).expect(200)).body).toBeNull();
    expect((await list(athleteA).expect(200)).body.map((p: { competitionId: string }) => p.competitionId)).toEqual([comp.past]);
  });

  it("9 : forfait -> jamais 'next', mais visible dans la liste avec son statut", async () => {
    await prep(coach1Id, athleteA.id, comp.near, { statut: "forfait" });

    expect((await next(athleteA).expect(200)).body).toBeNull();
    const listRes = await list(athleteA).expect(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0]).toMatchObject({ competitionId: comp.near, status: "forfait" });
  });

  it("10 : deux coachs, même compétition -> UNE entrée ; catégories contradictoires non exposées, statut le plus avancé", async () => {
    await prep(coach1Id, athleteA.id, comp.near, { statut: "envisage", age: "Senior", poids: "-68kg", note: NOTE_A });
    await prep(coach2Id, athleteA.id, comp.near, { statut: "pret", age: "Senior", poids: "-74kg", note: NOTE_B });

    const listRes = await list(athleteA).expect(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0]).toMatchObject({
      status: "pret",
      categorieAgePrevue: "Senior",
      categoriePoidsPrevue: null,
    });
    expect(listRes.text).not.toContain(NOTE_A);
    expect(listRes.text).not.toContain(NOTE_B);

    const nextRes = await next(athleteA).expect(200);
    expect(nextRes.body.competition.id).toBe(comp.near);
    expect(nextRes.body.preparation).toMatchObject({ categoriePoidsPrevue: null, categorieAgePrevue: "Senior" });
  });

  it("11 : catégories âge/poids exposées correctement quand une seule est renseignée", async () => {
    await prep(coach1Id, athleteA.id, comp.near, { age: null, poids: "-68kg" });

    const res = await list(athleteA).expect(200);
    expect(res.body[0]).toMatchObject({ categorieAgePrevue: null, categoriePoidsPrevue: "-68kg" });
  });

  it("coach retiré du roster de l'athlète -> sa préparation n'est plus visible côté athlète", async () => {
    await prep(coach2Id, athleteA.id, comp.near, {});
    await prisma.coach_athlete.deleteMany({ where: { coach_id: coach2Id, athlete_id: athleteA.id } });

    try {
      expect((await list(athleteA).expect(200)).body).toEqual([]);
      expect((await next(athleteA).expect(200)).body).toBeNull();
    } finally {
      await prisma.coach_athlete.create({ data: { coach_id: coach2Id, athlete_id: athleteA.id } });
    }
  });

  it("12 : lire next/liste ne crée, ne modifie, ne supprime aucune participation", async () => {
    await prep(coach1Id, athleteA.id, comp.near, {});
    // Comptes restreints à NOS fixtures : d'autres suites d'intégration
    // écrivent en parallèle dans la même table, un compte global serait flaky.
    const ours = { competition_id: { in: competitionIds } };
    const before = await prisma.participation.count({ where: ours });

    await next(athleteA).expect(200);
    await list(athleteA).expect(200);
    await request(app.getHttpServer()).get(`/athletes/${athleteA.id}/competitions`).set("Cookie", cookieFor(athleteA)).expect(200);

    expect(await prisma.participation.count({ where: ours })).toBe(before);
    expect(await prisma.participation.count({ where: { athlete_id: athleteA.id } })).toBe(0);
  });
});
