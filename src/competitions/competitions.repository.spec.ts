import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { CompetitionsRepository } from "./competitions.repository";
import { todayUtcMidnight } from "./next-competition";
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

  // #22 : divisions du calendrier WT persistées par source, idempotentes, sans
  // effet sur l'identité ni sur les champs canoniques.
  it("persiste raw_divisions d'une entrée calendrier WT et le ré-import est idempotent (mêmes UUID)", async () => {
    const divisions = [
      { dateText: "June 4", discipline: "Kyorugi / Cadet", start: "2027-06-04", end: "2027-06-04" },
      { dateText: "June 6-7", discipline: "Kyorugi / Senior", start: "2027-06-06", end: "2027-06-07" },
    ];
    const data = fixture({
      source: "world_taekwondo",
      sourceExternalId: extId("wt-div"),
      nom: "Division Test Cup",
      dateDebut: new Date("2027-06-04T00:00:00Z"),
      dateFin: new Date("2027-06-07T00:00:00Z"),
      divisions,
    });
    const first = await upsertAndTrack(data);
    const source1 = await prisma.competition_source.findFirstOrThrow({ where: { competition_id: first.competition.id } });
    expect(source1.raw_divisions).toEqual(divisions);

    const second = await upsertAndTrack(data);
    const source2 = await prisma.competition_source.findFirstOrThrow({ where: { competition_id: first.competition.id } });
    expect(second.outcome).toBe("updated");
    expect(second.competition.id).toBe(first.competition.id);
    expect(source2.id).toBe(source1.id);
    expect(source2.raw_divisions).toEqual(divisions);
    expect(await prisma.competition_source.count({ where: { source: "world_taekwondo", source_external_id: extId("wt-div") } })).toBe(1);
  });

  it("une source sans divisions (FFTDA) ne crée ni n'efface jamais raw_divisions", async () => {
    const created = await upsertAndTrack(fixture({ sourceExternalId: extId("no-div") }));
    const source = await prisma.competition_source.findFirstOrThrow({ where: { competition_id: created.competition.id } });
    expect(source.raw_divisions).toBeNull();

    // Même si la colonne était renseignée, un ré-import sans divisions ne l'efface pas.
    await prisma.competition_source.update({ where: { id: source.id }, data: { raw_divisions: [{ dateText: "x", discipline: null, start: null, end: null }] } });
    await upsertAndTrack(fixture({ sourceExternalId: extId("no-div") }));
    const after = await prisma.competition_source.findUniqueOrThrow({ where: { id: source.id } });
    expect(after.raw_divisions).toEqual([{ dateText: "x", discipline: null, start: null, end: null }]);
  });

  it("refreshSourceDivisions ne met à jour que raw_divisions d'une source connue, et jamais deux fois", async () => {
    const created = await upsertAndTrack(
      fixture({ source: "world_taekwondo", sourceExternalId: extId("refresh"), nom: "Refresh Cup", ville: "Nuremberg" }),
    );
    const before = await prisma.competition_source.findFirstOrThrow({ where: { competition_id: created.competition.id } });
    const canonicalBefore = await prisma.competition.findUniqueOrThrow({ where: { id: created.competition.id } });
    const divisions = [{ dateText: "January 1", discipline: "Poomsae", start: "2027-01-01", end: "2027-01-01" }];

    expect(await repository.refreshSourceDivisions("world_taekwondo", extId("refresh"), divisions)).toBe("updated");
    expect(await repository.refreshSourceDivisions("world_taekwondo", extId("refresh"), divisions)).toBe("unchanged");

    const after = await prisma.competition_source.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.raw_divisions).toEqual(divisions);
    expect({ ...after, raw_divisions: null }).toEqual({ ...before, raw_divisions: null });
    expect(await prisma.competition.findUniqueOrThrow({ where: { id: created.competition.id } })).toEqual(canonicalBefore);
  });

  it("refreshSourceDivisions ne crée jamais rien pour une source inconnue", async () => {
    // Comptages scopés (jamais globaux : la base est partagée avec les autres suites en parallèle).
    expect(await repository.refreshSourceDivisions("world_taekwondo", extId("unknown"), [])).toBe("unknownSource");
    expect(await prisma.competition_source.count({ where: { source_external_id: extId("unknown") } })).toBe(0);
    expect(await prisma.competition.count({ where: { sources: { some: { source_external_id: extId("unknown") } } } })).toBe(0);
  });

  it("la contrainte base refuse un raw_divisions qui n'est pas un tableau", async () => {
    const created = await upsertAndTrack(fixture({ sourceExternalId: extId("div-check") }));
    const source = await prisma.competition_source.findFirstOrThrow({ where: { competition_id: created.competition.id } });
    await expect(
      prisma.competition_source.update({ where: { id: source.id }, data: { raw_divisions: { not: "an array" } } }),
    ).rejects.toThrow();
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

  // Ticket "Compétitions Athlete V2" §8-9 : pagination réelle pour
  // l'explorateur, méthode entièrement nouvelle et séparée de findMany().
  describe("findManyPaginated — ticket Compétitions Athlete V2 §8-9", () => {
    async function createFixtures() {
      const future1 = await prisma.competition.create({
        data: { nom: `Paginated Upcoming A ${runId}`, date_debut: new Date(Date.now() + 5 * 86400000), ville: "Nice", pays: "France" },
      });
      const future2 = await prisma.competition.create({
        data: { nom: `Paginated Upcoming B ${runId}`, date_debut: new Date(Date.now() + 10 * 86400000), ville: "Lyon", pays: "France" },
      });
      const past1 = await prisma.competition.create({
        data: { nom: `Paginated Past A ${runId}`, date_debut: new Date(Date.now() - 5 * 86400000), ville: "Berlin", pays: "Germany" },
      });
      const past2 = await prisma.competition.create({
        data: { nom: `Paginated Past B ${runId}`, date_debut: new Date(Date.now() - 10 * 86400000), ville: "Madrid", pays: "Spain" },
      });
      createdCompetitionIds.push(future1.id, future2.id, past1.id, past2.id);
      return { future1, future2, past1, past2 };
    }

    it("page/limit : pagine réellement (skip/take), total reflète le compte réel filtré", async () => {
      const { future1, future2 } = await createFixtures();

      const page1 = await repository.findManyPaginated({ search: `Paginated Upcoming`, page: 1, limit: 1, scope: "upcoming" });
      expect(page1.items).toHaveLength(1);
      expect(page1.total).toBe(2);
      expect(page1.page).toBe(1);
      expect(page1.limit).toBe(1);
      // scope=upcoming ⇒ date_debut ASC : le plus proche (future1) en premier.
      expect(page1.items[0].id).toBe(future1.id);

      const page2 = await repository.findManyPaginated({ search: `Paginated Upcoming`, page: 2, limit: 1, scope: "upcoming" });
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0].id).toBe(future2.id);
    });

    it("scope=upcoming ne retourne que les compétitions futures, ASC", async () => {
      const { future1, future2 } = await createFixtures();
      const result = await repository.findManyPaginated({ search: `Paginated`, page: 1, limit: 10, scope: "upcoming" });
      expect(result.items.map((c) => c.id)).toEqual([future1.id, future2.id]);
    });

    it("scope=past ne retourne que les compétitions passées, DESC", async () => {
      const { past1, past2 } = await createFixtures();
      const result = await repository.findManyPaginated({ search: `Paginated`, page: 1, limit: 10, scope: "past" });
      expect(result.items.map((c) => c.id)).toEqual([past1.id, past2.id]);
    });

    // Ticket #18 : statut temporel sur la date de FIN effective (date_fin ??
    // date_debut) vs jour courant UTC partagé, et filtre année (date_debut).
    describe("statut (fin effective) + année (#18)", () => {
      const DAY = 86400000;
      const today = todayUtcMidnight();
      const day = (offset: number) => new Date(today.getTime() + offset * DAY);
      const tag = `Filtre18 ${runId}`;

      async function create(label: string, debut: Date, fin: Date | null = null) {
        const c = await prisma.competition.create({ data: { nom: `${tag} ${label}`, date_debut: debut, date_fin: fin } });
        createdCompetitionIds.push(c.id);
        return c;
      }

      it("un jour aujourd'hui ⇒ à venir ; multi-jours EN COURS ⇒ à venir (jamais passée) ; fini hier ⇒ passée ; un jour hier ⇒ passée", async () => {
        const todayOneDay = await create("un-jour-aujourdhui", day(0));
        const running = await create("en-cours", day(-1), day(1));
        const endsToday = await create("finit-aujourdhui", day(-2), day(0));
        const endedYesterday = await create("fini-hier", day(-3), day(-1));
        const oneDayYesterday = await create("un-jour-hier", day(-1));

        const upcoming = await repository.findManyPaginated({ search: tag, page: 1, limit: 20, scope: "upcoming" });
        const past = await repository.findManyPaginated({ search: tag, page: 1, limit: 20, scope: "past" });
        const all = await repository.findManyPaginated({ search: tag, page: 1, limit: 20 });

        expect(new Set(upcoming.items.map((c) => c.id))).toEqual(new Set([todayOneDay.id, running.id, endsToday.id]));
        expect(new Set(past.items.map((c) => c.id))).toEqual(new Set([endedYesterday.id, oneDayYesterday.id]));
        // Toutes = union exacte, sans doublon ni omission.
        expect(all.total).toBe(upcoming.total + past.total);
      });

      it("année = année de date_debut ; compose avec le statut (à venir + année, passée + année)", async () => {
        const y = today.getUTCFullYear();
        const pastThisYear = await create("passee-annee", new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y, 0, 2)));
        const pastLastYear = await create("passee-annee-1", new Date(Date.UTC(y - 1, 11, 30)), new Date(Date.UTC(y, 0, 0)));
        const upcomingNextYear = await create("avenir-annee+1", new Date(Date.UTC(y + 1, 5, 1)));
        // À cheval sur deux années : rattachée à l'année de son DÉBUT.
        const straddle = await create("a-cheval", new Date(Date.UTC(y + 1, 11, 31)), new Date(Date.UTC(y + 2, 0, 2)));

        const ids = async (params: { scope?: "upcoming" | "past"; year?: number }) =>
          (await repository.findManyPaginated({ search: tag, page: 1, limit: 20, ...params })).items.map((c) => c.id);

        // Garde : le 1er janvier, "passee-annee" n'est pas encore passée (on vérifie la vraie règle, pas le calendrier du jour).
        const pastThisYearIsPast = new Date(Date.UTC(y, 0, 2)) < today;
        expect(await ids({ scope: "past", year: y })).toEqual(pastThisYearIsPast ? [pastThisYear.id] : []);
        expect(await ids({ scope: "past", year: y - 1 })).toEqual([pastLastYear.id]);
        expect(await ids({ scope: "upcoming", year: y + 1 })).toEqual([upcomingNextYear.id, straddle.id]);
        expect(await ids({ year: y + 2 })).toEqual([]);
        expect(await ids({ scope: "upcoming", year: y - 1 })).toEqual([]);
      });

      it("pagination + filtres : ordre total stable à date égale (id en départage), aucun doublon entre pages", async () => {
        const sameDay = day(30);
        const created: { id: string }[] = [];
        for (let i = 0; i < 5; i++) created.push(await create(`meme-jour-${i}`, sameDay));
        const seen: string[] = [];
        for (let page = 1; page <= 3; page++) {
          const res = await repository.findManyPaginated({ search: `${tag} meme-jour`, page, limit: 2, scope: "upcoming", year: sameDay.getUTCFullYear() });
          expect(res.total).toBe(5);
          seen.push(...res.items.map((c) => c.id));
        }
        expect(seen).toEqual(created.map((c) => c.id).sort());
      });

      it("listYears : années réelles (date_debut), décroissantes, sans doublon", async () => {
        await create("annee-lointaine", new Date(Date.UTC(2097, 3, 1)));
        await create("annee-lointaine-bis", new Date(Date.UTC(2097, 8, 1)));
        const years = await repository.listYears();
        expect(years).toContain(2097);
        expect(years.filter((y) => y === 2097)).toHaveLength(1);
        expect([...years].sort((a, b) => b - a)).toEqual(years);
      });
    });

    it("search filtre par nom, ville OU pays (insensible à la casse)", async () => {
      const { future1, past1 } = await createFixtures();

      const byName = await repository.findManyPaginated({ search: `upcoming a ${runId}`, page: 1, limit: 10 });
      expect(byName.items.map((c) => c.id)).toEqual([future1.id]);

      const byVille = await repository.findManyPaginated({ search: "berlin", page: 1, limit: 10 });
      expect(byVille.items.some((c) => c.id === past1.id)).toBe(true);

      const byPays = await repository.findManyPaginated({ search: "germany", page: 1, limit: 10 });
      expect(byPays.items.some((c) => c.id === past1.id)).toBe(true);
    });

    it("comportement inchangé de findMany() historique (sans pagination) après ajout de findManyPaginated", async () => {
      await createFixtures();
      const before = await prisma.competition.count();
      const legacy = await repository.findMany();
      expect(legacy).toHaveLength(before);
      expect(Array.isArray(legacy)).toBe(true);
    });
  });

  // Ticket "Compétitions Athlete V2" §20 : liste complète des sources sur la
  // fiche détail (findById), au-delà du couple source/source_external_id
  // primaire déjà existant et jamais modifié.
  describe("findById — sources complètes (ticket §20)", () => {
    it("compétition mono-source : sources = [cette source]", async () => {
      const created = await upsertAndTrack(
        fixture({ source: "fftda", sourceExternalId: extId("detail-single"), nom: "Detail Mono Source" }),
      );
      const detail = await repository.findById(created.competition.id);
      expect(detail?.all_sources).toEqual([{ source: "fftda", source_url: null }]);
    });

    it("compétition multi-source (FFTDA + Martial Events, rattachement SAFE réel) : sources contient les deux", async () => {
      const fftda = await upsertAndTrack(
        fixture({
          source: "fftda",
          sourceExternalId: extId("detail-multi-fftda"),
          nom: "Chpt. Fra. senior (combat) Detail",
          dateDebut: new Date("2027-03-03T00:00:00Z"),
        }),
      );
      await upsertAndTrack(
        fixture({
          source: "martial_events",
          sourceExternalId: extId("detail-multi-me"),
          nom: "Championnat de France Seniors 2027 Detail",
          dateDebut: new Date("2027-03-03T00:00:00Z"),
        }),
      );

      const detail = await repository.findById(fftda.competition.id);
      expect(detail?.all_sources.map((s) => s.source).sort()).toEqual(["fftda", "martial_events"]);
    });
  });
});
