import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { CompetitionsRepository } from "./competitions.repository";
import { ImportedCompetition } from "./importers/imported-competition.interface";

// Test d'intégration contre la vraie base Postgres locale : la logique de
// dédoublonnage multi-source (contrainte unique, matching SAFE/AMBIGUOUS,
// politique de fusion "combler les null uniquement") dépend de comportements
// Prisma/SQL réels qu'un mock ne peut pas valider sincèrement (voir
// CLAUDE.md §23). Toutes les competitions créées ici utilisent un
// source_external_id suffixé par runId pour ne jamais entrer en collision
// avec les 122 competitions de développement réelles (FFTDA/WT), et sont
// nettoyées en afterEach — aucune donnée existante n'est jamais touchée.
describe("CompetitionsRepository (intégration Postgres)", () => {
  let prisma: PrismaService;
  let repository: CompetitionsRepository;
  const runId = Date.now();
  const createdCompetitionIds: string[] = [];

  beforeAll(() => {
    prisma = new PrismaService();
    repository = new CompetitionsRepository(prisma);
  }, 30000);

  afterEach(async () => {
    if (createdCompetitionIds.length > 0) {
      // onDelete: Cascade sur competition_source.competition_id : supprime
      // aussi les sources rattachées.
      await prisma.competition.deleteMany({ where: { id: { in: createdCompetitionIds } } });
      createdCompetitionIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  }, 30000);

  function extId(label: string): string {
    return `test-${runId}-${label}`;
  }

  function fixture(overrides: Partial<ImportedCompetition>): ImportedCompetition {
    return {
      source: "fftda",
      sourceExternalId: extId("default"),
      nom: "Événement Test",
      dateDebut: new Date("2027-01-01T00:00:00Z"),
      ...overrides,
    };
  }

  async function upsertAndTrack(data: ImportedCompetition) {
    const result = await repository.upsertFromSource(data);
    if (!createdCompetitionIds.includes(result.competition.id)) {
      createdCompetitionIds.push(result.competition.id);
    }
    return result;
  }

  it("source nouvelle sans aucun match ⇒ crée une nouvelle competition canonique + sa source", async () => {
    const result = await upsertAndTrack(
      fixture({ source: "fftda", sourceExternalId: extId("nouvelle"), nom: "Open Test Isolé" }),
    );

    expect(result.outcome).toBe("created");
    expect(result.created).toBe(true);

    const sources = await prisma.competition_source.findMany({ where: { competition_id: result.competition.id } });
    expect(sources).toHaveLength(1);
    expect(sources[0].source).toBe("fftda");
    expect(sources[0].match_confidence).toBeNull();
  });

  it("source déjà connue (même source + même source_external_id) ⇒ met à jour sans créer de doublon (idempotence)", async () => {
    const payload = fixture({ source: "fftda", sourceExternalId: extId("idempotent"), nom: "Open Idempotent" });

    const first = await upsertAndTrack(payload);
    const second = await upsertAndTrack({ ...payload, ville: "Paris" });

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("updated");
    expect(second.competition.id).toBe(first.competition.id);

    const sources = await prisma.competition_source.findMany({ where: { competition_id: first.competition.id } });
    expect(sources).toHaveLength(1);
  });

  it("idempotence FFTDA : deux imports identiques ⇒ une seule competition, une seule source", async () => {
    const payload = fixture({ source: "fftda", sourceExternalId: extId("fftda-idem"), nom: "Chpt Test FFTDA" });
    const first = await upsertAndTrack(payload);
    const second = await upsertAndTrack(payload);

    expect(first.competition.id).toBe(second.competition.id);
    const count = await prisma.competition_source.count({ where: { competition_id: first.competition.id } });
    expect(count).toBe(1);
  });

  it("idempotence World Taekwondo : deux imports identiques ⇒ une seule competition, une seule source", async () => {
    const payload = fixture({
      source: "world_taekwondo",
      sourceExternalId: extId("wt-idem"),
      nom: "WT Grand Prix Test",
    });
    const first = await upsertAndTrack(payload);
    const second = await upsertAndTrack(payload);

    expect(first.competition.id).toBe(second.competition.id);
    const count = await prisma.competition_source.count({ where: { competition_id: first.competition.id } });
    expect(count).toBe(1);
  });

  it("idempotence Martial Events : deux imports identiques ⇒ aucune nouvelle competition, aucune nouvelle source", async () => {
    const payload = fixture({
      source: "martial_events",
      sourceExternalId: extId("me-idem"),
      nom: "Open Martial Events Test",
    });
    const first = await upsertAndTrack(payload);
    const second = await upsertAndTrack(payload);

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("updated");
    expect(second.competition.id).toBe(first.competition.id);
    const count = await prisma.competition_source.count({ where: { competition_id: first.competition.id } });
    expect(count).toBe(1);
  });

  it("contrainte unique(source, source_external_id) réellement appliquée par Postgres", async () => {
    const extIdShared = extId("unique-constraint");
    const created = await prisma.competition.create({
      data: { nom: "Test Contrainte", date_debut: new Date("2027-02-02T00:00:00Z") },
    });
    createdCompetitionIds.push(created.id);

    await prisma.competition_source.create({
      data: { competition_id: created.id, source: "fftda", source_external_id: extIdShared },
    });

    await expect(
      prisma.competition_source.create({
        data: { competition_id: created.id, source: "fftda", source_external_id: extIdShared },
      }),
    ).rejects.toThrow();
  });

  describe("dédoublonnage réel FFTDA ↔ Martial Events (données réelles observées le 21/08/2026)", () => {
    it("Seniors : import FFTDA puis Martial Events ⇒ une seule competition canonique, deux sources", async () => {
      const fftdaSeniors = fixture({
        source: "fftda",
        sourceExternalId: extId("seniors-fftda"),
        nom: "Chpt. Fra. senior (combat) / Chpt. Fra Poomsae",
        dateDebut: new Date("2027-02-21T00:00:00Z"),
      });
      const meSeniors = fixture({
        source: "martial_events",
        sourceExternalId: extId("seniors-me"),
        nom: "Championnat de France Seniors (Combat) 2027",
        dateDebut: new Date("2027-02-21T00:00:00Z"),
        ville: "Eaubonne",
        pays: "France",
      });

      const first = await upsertAndTrack(fftdaSeniors);
      const second = await upsertAndTrack(meSeniors);

      expect(first.outcome).toBe("created");
      expect(second.outcome).toBe("attachedSafe");
      expect(second.competition.id).toBe(first.competition.id);

      const sources = await prisma.competition_source.findMany({ where: { competition_id: first.competition.id } });
      expect(sources.map((s) => s.source).sort()).toEqual(["fftda", "martial_events"]);
      expect(sources.find((s) => s.source === "martial_events")?.match_confidence).toBe("safe");
    });

    it("Cadet-Junior : import FFTDA puis Martial Events ⇒ une seule competition canonique, deux sources", async () => {
      const fftdaCadetJunior = fixture({
        source: "fftda",
        sourceExternalId: extId("cj-fftda"),
        nom: "Cpe Fra. Benj. Min. /Chpt.Fra. Cadet Junior",
        dateDebut: new Date("2027-05-23T00:00:00Z"),
      });
      const meCadetJunior = fixture({
        source: "martial_events",
        sourceExternalId: extId("cj-me"),
        nom: "Championnat de France Cadet-Junior",
        dateDebut: new Date("2027-05-23T00:00:00Z"),
        ville: "Verquin",
        pays: "France",
      });

      const first = await upsertAndTrack(fftdaCadetJunior);
      const second = await upsertAndTrack(meCadetJunior);

      expect(second.outcome).toBe("attachedSafe");
      expect(second.competition.id).toBe(first.competition.id);
    });

    it("Régionale IDF : aucun FFTDA à cette date ⇒ nouvelle competition distincte, une seule source", async () => {
      const meRegionale = fixture({
        source: "martial_events",
        sourceExternalId: extId("regionale"),
        nom: "Sélections Régionales IDF Combat - Championnat de France",
        dateDebut: new Date("2027-01-17T00:00:00Z"),
        ville: "Paris",
        pays: "France",
      });

      const result = await upsertAndTrack(meRegionale);
      expect(result.outcome).toBe("created");
      const count = await prisma.competition_source.count({ where: { competition_id: result.competition.id } });
      expect(count).toBe(1);
    });

    it("Open Bordeaux : aucune correspondance ⇒ nouvelle competition distincte", async () => {
      const meBordeaux = fixture({
        source: "martial_events",
        sourceExternalId: extId("bordeaux"),
        nom: "Open de Bordeaux Métropole",
        dateDebut: new Date("2027-09-19T00:00:00Z"),
        ville: "Pessac",
        pays: "France",
      });

      const result = await upsertAndTrack(meBordeaux);
      expect(result.outcome).toBe("created");
    });

    it("Poissy : faux positif géographique évité ⇒ deux competitions distinctes (dates réellement différentes)", async () => {
      const fftdaPoissy = fixture({
        source: "fftda",
        sourceExternalId: extId("poissy-fftda"),
        nom: "Open Labellisé de Poissy",
        dateDebut: new Date("2027-02-07T00:00:00Z"),
        ville: "Poissy",
      });
      const mePoissy = fixture({
        source: "martial_events",
        sourceExternalId: extId("poissy-me"),
        nom: "International Training Camp Poissy 2027",
        dateDebut: new Date("2027-10-28T00:00:00Z"),
        ville: "Poissy",
      });

      const first = await upsertAndTrack(fftdaPoissy);
      const second = await upsertAndTrack(mePoissy);

      expect(second.outcome).toBe("created");
      expect(second.competition.id).not.toBe(first.competition.id);
    });
  });

  it("AMBIGUOUS ⇒ jamais fusionné automatiquement : nouvelle competition distincte", async () => {
    const first = await upsertAndTrack(
      fixture({
        source: "fftda",
        sourceExternalId: extId("ambig-a"),
        nom: "Gala Sportif Annuel",
        dateDebut: new Date("2027-05-01T00:00:00Z"),
        ville: "Reims",
      }),
    );
    const second = await upsertAndTrack(
      fixture({
        source: "martial_events",
        sourceExternalId: extId("ambig-b"),
        nom: "Compétition Régionale de Printemps",
        dateDebut: new Date("2027-05-01T00:00:00Z"),
        ville: "Reims",
      }),
    );

    expect(second.outcome).toBe("created");
    expect(second.competition.id).not.toBe(first.competition.id);
  });

  it("plusieurs candidates SAFE pour la même source entrante ⇒ ne fusionne rien, crée une nouvelle competition distincte", async () => {
    // A et B sont deux competitions déjà existantes, distinctes l'une de
    // l'autre (aucune catégorie d'âge en commun entre elles : cadet vs
    // junior), mais partagent CHACUNE une catégorie d'âge différente avec le
    // même événement entrant "Cadet-Junior" — d'où deux matches SAFE
    // simultanés pour une seule source entrante, un cas volontairement
    // construit pour exercer le garde-fou du §6 du ticket.
    const dateDebut = new Date("2029-11-11T00:00:00Z");
    const first = await upsertAndTrack(
      fixture({
        source: "fftda",
        sourceExternalId: extId("multi-safe-1"),
        nom: "Cadets Nationaux 2029 (donnée dupliquée pour le test)",
        dateDebut,
      }),
    );
    const second = await upsertAndTrack(
      fixture({
        source: "world_taekwondo",
        sourceExternalId: extId("multi-safe-2"),
        nom: "Junior Open National 2029 (donnée dupliquée pour le test)",
        dateDebut,
      }),
    );
    expect(second.outcome).toBe("created");
    expect(second.competition.id).not.toBe(first.competition.id);

    const incoming = fixture({
      source: "martial_events",
      sourceExternalId: extId("multi-safe-incoming"),
      nom: "Championnat de France Cadet-Junior 2029",
      dateDebut,
    });
    const result = await upsertAndTrack(incoming);

    expect(result.outcome).toBe("created");
    expect(result.competition.id).not.toBe(first.competition.id);
    expect(result.competition.id).not.toBe(second.competition.id);
  });

  it("politique de fusion : ne remplace jamais un champ canonique déjà renseigné (comble uniquement les null)", async () => {
    const dateDebut = new Date("2027-04-04T00:00:00Z");
    const first = await upsertAndTrack(
      fixture({
        source: "fftda",
        sourceExternalId: extId("merge-fftda"),
        nom: "Chpt. Fra. senior (combat)",
        dateDebut,
        niveau: "national",
      }),
    );
    expect(first.competition.niveau).toBe("national");
    expect(first.competition.organisateur).toBeNull();

    const second = await upsertAndTrack(
      fixture({
        source: "martial_events",
        sourceExternalId: extId("merge-me"),
        nom: "Championnat de France Seniors 2027",
        dateDebut,
        niveau: "regional",
        organisateur: "Fédération Française de Taekwondo (FFTDA)",
      }),
    );

    expect(second.competition.id).toBe(first.competition.id);
    // niveau déjà renseigné par FFTDA ⇒ jamais écrasé par Martial Events.
    expect(second.competition.niveau).toBe("national");
    // organisateur était null ⇒ comblé par Martial Events.
    expect(second.competition.organisateur).toBe("Fédération Française de Taekwondo (FFTDA)");
  });

  it("les champs raw_* de competition_source reflètent la source elle-même, même si différents du canonique", async () => {
    const dateDebut = new Date("2027-06-06T00:00:00Z");
    const first = await upsertAndTrack(
      fixture({
        source: "fftda",
        sourceExternalId: extId("raw-fftda"),
        nom: "Chpt. Fra. senior (combat)",
        dateDebut,
        niveau: "national",
      }),
    );
    await upsertAndTrack(
      fixture({
        source: "martial_events",
        sourceExternalId: extId("raw-me"),
        nom: "Championnat de France Seniors 2027",
        dateDebut,
        niveau: "regional",
        ville: "Eaubonne",
      }),
    );

    const meSource = await prisma.competition_source.findFirst({
      where: { competition_id: first.competition.id, source: "martial_events" },
    });
    expect(meSource?.raw_niveau).toBe("regional");
    expect(meSource?.raw_ville).toBe("Eaubonne");
    // La valeur canonique reste "national" (comblage null-only), mais la
    // donnée brute Martial Events "regional" n'est jamais perdue.
    const canonical = await prisma.competition.findUniqueOrThrow({ where: { id: first.competition.id } });
    expect(canonical.niveau).toBe("national");
  });

  // Ticket "Sélection & préparation V1" §23 : recherche catalogue pour
  // "+ Préparer une compétition" — ajout additif à findMany(), jamais un
  // second catalogue.
  describe("findMany(search) — ajout additif §23", () => {
    it("filtre par nom, insensible à la casse, sans toucher le comportement par défaut", async () => {
      const competition = await prisma.competition.create({
        data: { nom: `Championnat Recherche Unique ${runId}`, date_debut: new Date() },
      });
      createdCompetitionIds.push(competition.id);

      const matches = await repository.findMany("recherche unique");
      expect(matches.some((c) => c.id === competition.id)).toBe(true);

      const noMatches = await repository.findMany(`introuvable-${runId}`);
      expect(noMatches).toHaveLength(0);

      // Sans paramètre : comportement historique inchangé (toutes les
      // competitions, y compris celle créée ici).
      const all = await repository.findMany();
      expect(all.some((c) => c.id === competition.id)).toBe(true);
    });
  });
});
