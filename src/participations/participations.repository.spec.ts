import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { ParticipationsRepository } from "./participations.repository";

// Test d'intégration contre la vraie base Postgres locale : la sélection de la
// "prochaine compétition" (tri + filtre de date + exclusion de statut) est une
// logique de requête Prisma qu'un mock ne peut pas valider sincèrement. Toutes les
// données créées ici sont préfixées "test_fixture_participations" et nettoyées en
// afterAll — les 32 compétitions FFTDA et les compétitions World Taekwondo réelles
// ne sont jamais touchées.
describe("ParticipationsRepository (intégration Postgres)", () => {
  let prisma: PrismaService;
  let repository: ParticipationsRepository;

  let athleteId: string;
  let userId: string;
  const competitionIds: Record<"past" | "today" | "plus10" | "plus30", string> = {
    past: "",
    today: "",
    plus10: "",
    plus30: "",
  };
  const participationIds: string[] = [];

  const runId = Date.now();
  const todayUtcMidnight = (() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  })();

  function daysFromToday(offset: number): Date {
    const d = new Date(todayUtcMidnight);
    d.setUTCDate(d.getUTCDate() + offset);
    return d;
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    repository = new ParticipationsRepository(prisma);

    const user = await prisma.app_user.create({
      data: { email: `test-fixture-participations-${runId}@test.fr`, nom: "Fixture", prenom: "Test" },
    });
    userId = user.id;

    const athlete = await prisma.athlete.create({ data: { user_id: userId } });
    athleteId = athlete.id;

    const makeCompetition = (key: keyof typeof competitionIds, offset: number) =>
      prisma.competition
        .create({
          data: {
            nom: `Fixture ${key} ${runId}`,
            date_debut: daysFromToday(offset),
            sources: {
              create: {
                source: "test_fixture_participations",
                source_external_id: `${runId}-${key}`,
              },
            },
          },
        })
        .then((c) => {
          competitionIds[key] = c.id;
        });

    await Promise.all([
      makeCompetition("past", -5),
      makeCompetition("today", 0),
      makeCompetition("plus10", 10),
      makeCompetition("plus30", 30),
    ]);

    for (const key of ["past", "today", "plus10", "plus30"] as const) {
      const participation = await prisma.participation.create({
        data: { athlete_id: athleteId, competition_id: competitionIds[key] },
      });
      participationIds.push(participation.id);
    }
  }, 30000);

  afterAll(async () => {
    await prisma.participation.deleteMany({ where: { id: { in: participationIds } } });
    await prisma.competition.deleteMany({ where: { id: { in: Object.values(competitionIds) } } });
    await prisma.athlete.delete({ where: { id: athleteId } });
    await prisma.app_user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  }, 30000);

  it("findAllByAthlete trie les participations par date de compétition croissante", async () => {
    const all = await repository.findAllByAthlete(athleteId);
    const testRows = all.filter((p) => Object.values(competitionIds).includes(p.competition.id));

    expect(testRows.map((p) => p.competition.id)).toEqual([
      competitionIds.past,
      competitionIds.today,
      competitionIds.plus10,
      competitionIds.plus30,
    ]);
  });

  it("findNextByAthlete sélectionne la compétition d'aujourd'hui plutôt que la passée", async () => {
    const next = await repository.findNextByAthlete(athleteId, todayUtcMidnight);
    expect(next?.competition.id).toBe(competitionIds.today);
  });

  it("une compétition passée n'est jamais retournée comme prochaine compétition", async () => {
    const next = await repository.findNextByAthlete(athleteId, todayUtcMidnight);
    expect(next?.competition.id).not.toBe(competitionIds.past);
  });

  it("ignore une participation annulée et sélectionne la suivante valide (+10 jours)", async () => {
    await prisma.participation.updateMany({
      where: { athlete_id: athleteId, competition_id: competitionIds.today },
      data: { statut: "annule" },
    });

    const next = await repository.findNextByAthlete(athleteId, todayUtcMidnight);
    expect(next?.competition.id).toBe(competitionIds.plus10);

    // restaure l'état pour ne pas affecter d'éventuels tests suivants
    await prisma.participation.updateMany({
      where: { athlete_id: athleteId, competition_id: competitionIds.today },
      data: { statut: "inscrit" },
    });
  });

  it("aucune compétition future active -> null", async () => {
    const farFuture = daysFromToday(3650);
    const next = await repository.findNextByAthlete(athleteId, farFuture);
    expect(next).toBeNull();
  });

  it("athleteExists distingue un athlète existant d'un UUID inconnu", async () => {
    await expect(repository.athleteExists(athleteId)).resolves.toBe(true);
    await expect(repository.athleteExists("00000000-0000-0000-0000-000000000000")).resolves.toBe(
      false,
    );
  });

  it("findByAthleteAndCompetition retrouve une participation existante via la clé composite", async () => {
    const found = await repository.findByAthleteAndCompetition(athleteId, competitionIds.plus30);
    expect(found).not.toBeNull();
    expect(found?.competition_id).toBe(competitionIds.plus30);
  });

  describe("updateResult", () => {
    it("met à jour tous les champs fournis", async () => {
      const participationId = await findParticipationId(prisma, athleteId, competitionIds.past);

      const updated = await repository.updateResult(participationId, {
        classement: 3,
        medaille: "bronze",
        victoires: 4,
        defaites: 1,
      });

      expect(updated).toMatchObject({ classement: 3, medaille: "bronze", victoires: 4, defaites: 1 });
    });

    // Preuve réelle (pas un mock) de la garantie Prisma sur laquelle repose
    // toute la sémantique "PATCH partiel" du service : une clé absente de
    // `data` (valeur `undefined`) est omise de la requête SQL générée, jamais
    // réécrite à null/0.
    it("un champ absent du data n'écrase pas la valeur déjà en base", async () => {
      const participationId = await findParticipationId(prisma, athleteId, competitionIds.past);

      await repository.updateResult(participationId, {
        classement: 5,
        medaille: "argent",
        victoires: 2,
        defaites: 0,
      });

      const corrected = await repository.updateResult(participationId, {
        classement: 2,
        medaille: undefined,
        victoires: undefined,
        defaites: undefined,
      });

      expect(corrected).toMatchObject({ classement: 2, medaille: "argent", victoires: 2, defaites: 0 });
    });

    it("victoires: 0 explicitement fourni est bien persisté (jamais confondu avec absent)", async () => {
      const participationId = await findParticipationId(prisma, athleteId, competitionIds.plus10);

      const updated = await repository.updateResult(participationId, { victoires: 0, defaites: 3 });

      expect(updated.victoires).toBe(0);
      expect(updated.defaites).toBe(3);
    });

    // Preuve réelle contre Postgres : `medaille: null` doit réellement écrire
    // NULL en base (retrait d'une médaille déjà enregistrée), tout en laissant
    // les autres colonnes strictement inchangées.
    it("medaille: null supprime réellement la valeur en base, sans toucher aux autres champs", async () => {
      const participationId = await findParticipationId(prisma, athleteId, competitionIds.plus30);

      await repository.updateResult(participationId, {
        classement: 3,
        medaille: "bronze",
        victoires: 3,
        defaites: 1,
      });

      const updated = await repository.updateResult(participationId, { medaille: null });

      expect(updated).toMatchObject({ classement: 3, medaille: null, victoires: 3, defaites: 1 });

      const persisted = await prisma.participation.findUniqueOrThrow({ where: { id: participationId } });
      expect(persisted.medaille).toBeNull();
      expect(persisted.classement).toBe(3);
      expect(persisted.victoires).toBe(3);
      expect(persisted.defaites).toBe(1);
    });
  });
});

async function findParticipationId(
  prisma: PrismaService,
  athleteId: string,
  competitionId: string,
): Promise<string> {
  const participation = await prisma.participation.findUniqueOrThrow({
    where: { athlete_id_competition_id: { athlete_id: athleteId, competition_id: competitionId } },
    select: { id: true },
  });
  return participation.id;
}
