import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { CompetitionEntriesRepository } from "./competition-entries.repository";
import { MartialEventsCategoryEntries } from "./importers/martial-events/me-normalizer";

// Test d'intégration contre la vraie base Postgres locale : la synchronisation
// miroir (upsert + suppression des entries obsolètes, transactionnelle, unicité
// composite) dépend de comportements Prisma/SQL réels qu'un mock ne peut pas
// valider sincèrement (voir CLAUDE.md §23). Chaque test crée sa propre
// competition jetable (nettoyée en afterEach) — jamais les 124 competitions
// réelles de dev.
describe("CompetitionEntriesRepository (intégration Postgres)", () => {
  let prisma: PrismaService;
  let repository: CompetitionEntriesRepository;
  const createdCompetitionIds: string[] = [];

  beforeAll(() => {
    prisma = new PrismaService();
    repository = new CompetitionEntriesRepository(prisma);
  }, 30000);

  afterEach(async () => {
    if (createdCompetitionIds.length > 0) {
      // onDelete: Cascade sur competition_entry.competition_id.
      await prisma.competition.deleteMany({ where: { id: { in: createdCompetitionIds } } });
      createdCompetitionIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  }, 30000);

  async function makeCompetition(nom: string): Promise<string> {
    const competition = await prisma.competition.create({
      data: { nom, date_debut: new Date("2027-01-01T00:00:00Z") },
    });
    createdCompetitionIds.push(competition.id);
    return competition.id;
  }

  function categories(...entries: { name: string; club?: string | null; league?: string | null; country?: string | null }[]): MartialEventsCategoryEntries[] {
    return [
      {
        category: { rawLabel: "Seniors Masculins -74 kg", ageCategory: "Senior", gender: "male", weightCategory: "-74 kg" },
        entries: entries.map((e) => ({
          name: e.name,
          club: e.club ?? null,
          league: e.league ?? null,
          country: e.country ?? null,
        })),
      },
    ];
  }

  it("insère 3 entries depuis un état vide", async () => {
    const competitionId = await makeCompetition("Fixture insert 3");

    const result = await repository.syncForCompetition(
      competitionId,
      "martial_events",
      categories({ name: "Dupont Jean" }, { name: "Martin Léa" }, { name: "Durand Paul" }),
    );

    expect(result).toEqual({ imported: 3, updated: 0, removed: 0, total: 3 });
    const rows = await repository.findByCompetition(competitionId);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.participant_name).sort()).toEqual(["Dupont Jean", "Durand Paul", "Martin Léa"]);
  });

  it("re-synchronisation identique : idempotente (aucune duplication, aucun changement)", async () => {
    const competitionId = await makeCompetition("Fixture idempotence");
    const cats = categories({ name: "Dupont Jean", club: "TKD Paris" });

    const first = await repository.syncForCompetition(competitionId, "martial_events", cats);
    const second = await repository.syncForCompetition(competitionId, "martial_events", cats);

    expect(first).toEqual({ imported: 1, updated: 0, removed: 0, total: 1 });
    expect(second).toEqual({ imported: 0, updated: 0, removed: 0, total: 1 });
    const rows = await repository.findByCompetition(competitionId);
    expect(rows).toHaveLength(1);
  });

  it("met à jour club/league/country d'une entry existante sans la dupliquer", async () => {
    const competitionId = await makeCompetition("Fixture update champs");
    await repository.syncForCompetition(
      competitionId,
      "martial_events",
      categories({ name: "Dupont Jean", club: "TKD Paris", league: "IDF", country: "France" }),
    );

    const result = await repository.syncForCompetition(
      competitionId,
      "martial_events",
      categories({ name: "Dupont Jean", club: "TKD Lyon", league: "AURA", country: "France" }),
    );

    expect(result).toEqual({ imported: 0, updated: 1, removed: 0, total: 1 });
    const rows = await repository.findByCompetition(competitionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].club).toBe("TKD Lyon");
    expect(rows[0].league).toBe("AURA");
  });

  it("retire une entry devenue absente de la source après une synchronisation réussie (miroir)", async () => {
    const competitionId = await makeCompetition("Fixture stale removal");
    await repository.syncForCompetition(
      competitionId,
      "martial_events",
      categories({ name: "Dupont Jean" }, { name: "Martin Léa" }),
    );

    const result = await repository.syncForCompetition(
      competitionId,
      "martial_events",
      categories({ name: "Dupont Jean" }),
    );

    expect(result).toEqual({ imported: 0, updated: 0, removed: 1, total: 1 });
    const rows = await repository.findByCompetition(competitionId);
    expect(rows.map((r) => r.participant_name)).toEqual(["Dupont Jean"]);
  });

  it("isole deux competitions : mêmes nom+catégorie sur deux competitions différentes n'entrent jamais en collision", async () => {
    const competitionIdA = await makeCompetition("Fixture isolation A");
    const competitionIdB = await makeCompetition("Fixture isolation B");
    const cats = categories({ name: "Dupont Jean" });

    await repository.syncForCompetition(competitionIdA, "martial_events", cats);
    await repository.syncForCompetition(competitionIdB, "martial_events", cats);

    const rowsA = await repository.findByCompetition(competitionIdA);
    const rowsB = await repository.findByCompetition(competitionIdB);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0].id).not.toBe(rowsB[0].id);

    // Supprimer toutes les entries de A ne doit jamais affecter B.
    await repository.syncForCompetition(competitionIdA, "martial_events", []);
    expect(await repository.findByCompetition(competitionIdA)).toHaveLength(0);
    expect(await repository.findByCompetition(competitionIdB)).toHaveLength(1);
  });

  it("la suppression de la competition supprime en cascade ses entries", async () => {
    const competitionId = await makeCompetition("Fixture cascade");
    await repository.syncForCompetition(competitionId, "martial_events", categories({ name: "Dupont Jean" }));

    await prisma.competition.delete({ where: { id: competitionId } });
    createdCompetitionIds.splice(createdCompetitionIds.indexOf(competitionId), 1);

    const remaining = await prisma.competition_entry.findMany({ where: { competition_id: competitionId } });
    expect(remaining).toHaveLength(0);
  });

  it("contrainte unique (competition_id, source, participant_name, source_category_raw_label) réellement appliquée par Postgres", async () => {
    const competitionId = await makeCompetition("Fixture contrainte unique");
    await prisma.competition_entry.create({
      data: {
        competition_id: competitionId,
        source: "martial_events",
        source_category_raw_label: "Seniors Masculins -74 kg",
        participant_name: "Dupont Jean",
      },
    });

    await expect(
      prisma.competition_entry.create({
        data: {
          competition_id: competitionId,
          source: "martial_events",
          source_category_raw_label: "Seniors Masculins -74 kg",
          participant_name: "Dupont Jean",
        },
      }),
    ).rejects.toThrow();
  });

  it("rollback transactionnel : une erreur pendant la synchronisation n'applique aucun changement partiel", async () => {
    const competitionId = await makeCompetition("Fixture rollback");
    await repository.syncForCompetition(
      competitionId,
      "martial_events",
      categories({ name: "Dupont Jean" }, { name: "Martin Léa" }),
    );

    const tooLongName = "X".repeat(300); // dépasse VARCHAR(255) -> erreur Postgres réelle pendant createMany
    const invalidCategories = categories({ name: "Nouveau Participant" }, { name: tooLongName });

    await expect(repository.syncForCompetition(competitionId, "martial_events", invalidCategories)).rejects.toThrow();

    // Aucun changement partiel : ni le nouvel inscrit valide ni la
    // suppression implicite des 2 anciens n'ont été appliqués.
    const rows = await repository.findByCompetition(competitionId);
    expect(rows.map((r) => r.participant_name).sort()).toEqual(["Dupont Jean", "Martin Léa"]);
  });

  it("dédoublonne un homonyme exact dans la même catégorie plutôt que de faire échouer toute la synchronisation (limite documentée)", async () => {
    const competitionId = await makeCompetition("Fixture homonyme");

    const result = await repository.syncForCompetition(
      competitionId,
      "martial_events",
      categories({ name: "Dupont Jean", club: "Club A" }, { name: "Dupont Jean", club: "Club B" }),
    );

    expect(result.total).toBe(1);
    const rows = await repository.findByCompetition(competitionId);
    expect(rows).toHaveLength(1);
    // La dernière occurrence rencontrée l'emporte (règle documentée, jamais un choix caché).
    expect(rows[0].club).toBe("Club B");
  });
});
