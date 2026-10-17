import "dotenv/config";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { CompetitionsRepository } from "../../competitions/competitions.repository";
import { describeOnTestDatabase } from "../../test-utils/test-database";
import { AdminAuditLogger } from "../admin-audit.logger";
import { AdminStatsService } from "../admin-stats.controller";
import { MANUAL_SOURCE } from "./admin-competition-origin";
import { AdminCompetitionsRepository, CompetitionNoLongerManualError } from "./admin-competitions.repository";
import { AdminCompetitionsService } from "./admin-competitions.service";

const ADMIN_ID = "0b6f3c1e-2a4d-4e5f-9a7b-1c2d3e4f5a6b";
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

// Intégration Postgres réelle, UNIQUEMENT sur la base de test isolée
// (npm run test:testdb). Toutes les compétitions créées portent RUN dans leur
// nom et des dates en 2098 (aucune donnée réelle à cette période) ; elles
// sont supprimées en afterAll (sources en cascade). Les imports passent par
// le VRAI chemin des importeurs (CompetitionsRepository.upsertFromSource),
// pour prouver que synchro et déduplication restent inchangées.
describeOnTestDatabase("Compétitions EkvaraAdmin (intégration Postgres, base de test)", () => {
  const RUN = `AdminIT${Date.now()}`;
  let prisma: PrismaService;
  let competitionsRepository: CompetitionsRepository;
  let adminRepository: AdminCompetitionsRepository;
  let audit: AdminAuditLogger;
  let service: AdminCompetitionsService;

  beforeAll(() => {
    prisma = new PrismaService();
    competitionsRepository = new CompetitionsRepository(prisma);
    adminRepository = new AdminCompetitionsRepository(prisma);
    audit = new AdminAuditLogger();
    jest.spyOn(audit, "record").mockImplementation(() => undefined);
    jest.spyOn(audit, "denied").mockImplementation(() => undefined);
    service = new AdminCompetitionsService(adminRepository, competitionsRepository, audit);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(audit, "record").mockImplementation(() => undefined);
    jest.spyOn(audit, "denied").mockImplementation(() => undefined);
  });

  afterAll(async () => {
    await prisma.competition.deleteMany({ where: { nom: { contains: RUN } } });
    await prisma.$disconnect();
  });

  const countByName = (nom: string) => prisma.competition.count({ where: { nom } });

  // Compétition "importée" créée par le chemin réel des importeurs.
  function importFromFftda(externalId: string, nom: string, dateDebut: string, extra: { lieu?: string; ville?: string; dateFin?: string } = {}) {
    return competitionsRepository.upsertFromSource({
      source: "fftda",
      sourceExternalId: `${RUN}-${externalId}`,
      nom,
      dateDebut: day(dateDebut),
      dateFin: extra.dateFin ? day(extra.dateFin) : undefined,
      lieu: extra.lieu,
      ville: extra.ville,
    });
  }

  describe("création manuelle", () => {
    it("crée la compétition ET sa provenance ekvara_manual (identifiant interne stable)", async () => {
      const nom = `${RUN} Open Création`;
      const created = await service.create(
        { nom, dateDebut: "2098-01-10", dateFin: "2098-01-11", ville: "Eaubonne", pays: "France", saison: "2097-2098" },
        ADMIN_ID,
      );

      expect(created).toMatchObject({ nom, dateDebut: "2098-01-10", dateFin: "2098-01-11", origin: "manual", saison: "2097-2098" });
      expect(created.organisateur).toBeNull();
      expect(created.lieu).toBeNull();
      const sources = await prisma.competition_source.findMany({ where: { competition_id: created.id } });
      expect(sources).toHaveLength(1);
      expect(sources[0]).toMatchObject({ source: MANUAL_SOURCE, source_external_id: created.id, match_confidence: null, raw_nom: nom });
      expect(audit.record).toHaveBeenCalledWith("admin.competition.created", expect.objectContaining({ userId: ADMIN_ID, competitionId: created.id }));
    });

    it("prévisualisation : validations et doublons, aucune écriture", async () => {
      const nom = `${RUN} Open Prévisualisation`;
      // Comptages limités aux données de CE fichier : d'autres specs écrivent
      // en parallèle dans la même base de test (un total global serait instable).
      const ownCompetitions = () => prisma.competition.count({ where: { nom: { contains: RUN } } });
      const ownManualSources = () => prisma.competition_source.count({ where: { source: MANUAL_SOURCE, raw_nom: { contains: RUN } } });
      const [competitionsBefore, sourcesBefore] = [await ownCompetitions(), await ownManualSources()];

      const preview = await service.previewCreate({ nom, dateDebut: "2098-01-20" });
      expect(preview.data).toMatchObject({ nom, dateDebut: "2098-01-20", dateFin: null });
      expect(preview.warnings).toEqual(expect.arrayContaining(["Date de fin non renseignée.", "Pays non renseigné."]));
      expect(await countByName(nom)).toBe(0);
      expect(await ownCompetitions()).toBe(competitionsBefore);
      expect(await ownManualSources()).toBe(sourcesBefore);
    });

    it.each([
      ["date inexistante", { dateDebut: "2098-02-30" }],
      ["année hors bornes", { dateDebut: "1999-05-01" }],
      ["fin avant début", { dateDebut: "2098-03-10", dateFin: "2098-03-09" }],
    ])("validation métier : %s -> 400, rien n'est écrit", async (_label, dates) => {
      const nom = `${RUN} Open Invalide ${_label}`;
      await expect(service.create({ nom, ...dates }, ADMIN_ID)).rejects.toBeInstanceOf(BadRequestException);
      expect(await countByName(nom)).toBe(0);
    });

    it("transaction : si la provenance échoue, la compétition n'est pas créée", async () => {
      const nom = `${RUN} Open Transaction`;
      const original = prisma.$transaction.bind(prisma) as (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
      jest.spyOn(prisma, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>) =>
        original((tx) =>
          fn(
            new Proxy(tx as object, {
              get(target, property) {
                const value = (target as Record<string | symbol, unknown>)[property];
                if (property !== "competition_source") return value;
                return new Proxy(value as object, {
                  get(delegate, method) {
                    if (method === "create") return () => Promise.reject(new Error("échec simulé de competition_source"));
                    return (delegate as Record<string | symbol, unknown>)[method];
                  },
                });
              },
            }),
          ),
        )) as never);

      await expect(service.create({ nom, dateDebut: "2098-03-20" }, ADMIN_ID)).rejects.toThrow("échec simulé");
      expect(await countByName(nom)).toBe(0);
    });
  });

  describe("doublons : détectés, jamais fusionnés", () => {
    it("compétition strictement identique -> 409 bloquant, même avec confirmation ; rien n'est écrit", async () => {
      const nom = `${RUN} Championnat de France Cadets`;
      const fields = { nom, dateDebut: "2098-04-04", dateFin: "2098-04-05", ville: "Orléans", pays: "France" };
      const first = await service.create(fields, ADMIN_ID);

      const preview = await service.previewCreate({ ...fields, nom: nom.toUpperCase() });
      expect(preview.blocking).toMatch(/existe déjà/);
      expect(preview.candidates).toEqual([expect.objectContaining({ id: first.id, exact: true })]);

      const error = await service.create({ ...fields, acknowledgedDuplicateIds: [first.id] }, ADMIN_ID).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ blocking: true, candidates: [expect.objectContaining({ id: first.id })] });
      expect(await countByName(nom)).toBe(1);
    });

    it("même nom et même date mais autre ville -> 409 à confirmer ; confirmation explicite -> deux compétitions distinctes", async () => {
      const nom = `${RUN} Open International`;
      const first = await service.create({ nom, dateDebut: "2098-12-05", ville: "Paris" }, ADMIN_ID);

      const error = await service.create({ nom, dateDebut: "2098-12-05", ville: "Lyon" }, ADMIN_ID).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      const body = (error as ConflictException).getResponse() as { blocking?: boolean; candidates: { id: string; level: string; exact: boolean }[] };
      expect(body.blocking).toBeUndefined();
      expect(body.candidates).toEqual([expect.objectContaining({ id: first.id, exact: false })]);
      expect(await countByName(nom)).toBe(1);

      const second = await service.create({ nom, dateDebut: "2098-12-05", ville: "Lyon", acknowledgedDuplicateIds: [first.id] }, ADMIN_ID);
      expect(second.id).not.toBe(first.id);
      expect(await countByName(nom)).toBe(2);
      const firstSources = await prisma.competition_source.findMany({ where: { competition_id: first.id } });
      expect(firstSources).toHaveLength(1);
    });

    it("compétition IMPORTÉE strictement identique -> création manuelle refusée (bloquant)", async () => {
      const imported = await importFromFftda("exact", `${RUN} Coupe Régionale`, "2098-12-20", { ville: "Tours" });
      const error = await service
        .create({ nom: `${RUN} Coupe Régionale`, dateDebut: "2098-12-20", ville: "Tours", acknowledgedDuplicateIds: [imported.competition.id] }, ADMIN_ID)
        .catch((e: unknown) => e);
      expect((error as ConflictException).getResponse()).toMatchObject({ blocking: true });
      expect(await countByName(`${RUN} Coupe Régionale`)).toBe(1);
    });

    it("modification rendant une compétition strictement identique à une autre -> refusée (bloquant), aucune écriture", async () => {
      const nom = `${RUN} Interclubs`;
      await service.create({ nom, dateDebut: "2098-10-20", ville: "Nantes" }, ADMIN_ID);
      const other = await service.create({ nom, dateDebut: "2098-10-20", ville: "Rennes" }, ADMIN_ID).catch(async (e: ConflictException) =>
        service.create(
          { nom, dateDebut: "2098-10-20", ville: "Rennes", acknowledgedDuplicateIds: (e.getResponse() as { candidates: { id: string }[] }).candidates.map((c) => c.id) },
          ADMIN_ID,
        ),
      );

      expect((await service.previewUpdate(other.id, { ville: "Nantes" })).blocking).toMatch(/existe déjà/);
      const error = await service.update(other.id, { ville: "Nantes" }, ADMIN_ID).catch((e: unknown) => e);
      expect((error as ConflictException).getResponse()).toMatchObject({ blocking: true });
      expect((await service.getDetail(other.id)).ville).toBe("Rennes");
    });

    it("date proche (± 7 jours) d'une compétition IMPORTÉE -> candidate possible signalée", async () => {
      const imported = await importFromFftda("near", `${RUN} Coupe de France Juniors`, "2098-05-10");
      const preview = await service.previewCreate({ nom: `${RUN} Coupe de France Juniors`, dateDebut: "2098-05-12" });
      expect(preview.candidates).toEqual([
        expect.objectContaining({ id: imported.competition.id, level: "possible", dayGap: -2, sources: ["fftda"] }),
      ]);
    });
  });

  describe("modification", () => {
    it("compétition manuelle : tous les champs modifiables, provenance brute mise à jour", async () => {
      const created = await service.create({ nom: `${RUN} Open Modifiable`, dateDebut: "2098-06-06" }, ADMIN_ID);
      const updated = await service.update(created.id, { ville: "Lyon", pays: "France", niveau: "national", dateFin: "2098-06-07" }, ADMIN_ID);

      expect(updated).toMatchObject({ ville: "Lyon", pays: "France", niveau: "national", dateFin: "2098-06-07", origin: "manual" });
      const source = await prisma.competition_source.findFirstOrThrow({ where: { competition_id: created.id } });
      expect(source).toMatchObject({ raw_ville: "Lyon", raw_pays: "France", raw_niveau: "national" });
      expect(audit.record).toHaveBeenCalledWith(
        "admin.competition.updated",
        expect.objectContaining({ competitionId: created.id, fields: ["dateFin", "ville", "pays", "niveau"] }),
      );
    });

    it("modification sans changement réel : aucune écriture", async () => {
      const created = await service.create({ nom: `${RUN} Open Inchangé`, dateDebut: "2098-06-16", ville: "Paris" }, ADMIN_ID);
      const before = await prisma.competition.findUniqueOrThrow({ where: { id: created.id } });
      await service.update(created.id, { ville: "Paris" }, ADMIN_ID);
      const after = await prisma.competition.findUniqueOrThrow({ where: { id: created.id } });
      expect(after.updated_at).toEqual(before.updated_at);
    });

    it("compétition importée : saison modifiable, tout autre champ refusé (403) sans écriture", async () => {
      const { competition } = await importFromFftda("ro", `${RUN} Open Importé`, "2098-07-07", { lieu: "Gymnase A" });

      const updated = await service.update(competition.id, { saison: "2097-2098" }, ADMIN_ID);
      expect(updated).toMatchObject({ saison: "2097-2098", origin: "imported", editableFields: ["saison"] });

      await expect(service.update(competition.id, { nom: "Renommée" }, ADMIN_ID)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.update(competition.id, { saison: "x", lieu: "Gymnase B" }, ADMIN_ID)).rejects.toBeInstanceOf(ForbiddenException);
      const row = await prisma.competition.findUniqueOrThrow({ where: { id: competition.id } });
      expect(row).toMatchObject({ nom: `${RUN} Open Importé`, lieu: "Gymnase A", saison: "2097-2098" });
    });
  });

  describe("synchronisation et déduplication préservées", () => {
    it("saison modifiée : la synchro de la source reporte toujours dates/lieu, et ne touche pas la saison", async () => {
      const { competition } = await importFromFftda("sync", `${RUN} Open Synchro`, "2098-08-01", { lieu: "Gymnase A" });
      await service.update(competition.id, { saison: "2097-2098" }, ADMIN_ID);

      const resync = await importFromFftda("sync", `${RUN} Open Synchro`, "2098-08-02", { lieu: "Gymnase B" });
      expect(resync.outcome).toBe("updated");
      expect(resync.changes).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "date_debut" }), expect.objectContaining({ field: "lieu", after: "Gymnase B" })]),
      );
      const row = await prisma.competition.findUniqueOrThrow({ where: { id: competition.id } });
      expect(row.date_debut).toEqual(day("2098-08-02"));
      expect(row.lieu).toBe("Gymnase B");
      expect(row.saison).toBe("2097-2098");
    });

    it("saisie manuelle puis import FFTDA du même événement : rattachement SAFE existant, valeurs manuelles conservées, compétition alors en lecture seule", async () => {
      const manual = await service.create(
        { nom: `${RUN} Championnat de France Seniors`, dateDebut: "2098-09-12", ville: "Orléans", saison: "2098" },
        ADMIN_ID,
      );
      const imported = await importFromFftda("attach", `${RUN} Chpt France Seniors`, "2098-09-12", { ville: "Orleans", lieu: "Palais des sports" });

      expect(imported.outcome).toBe("attachedSafe");
      expect(imported.competition.id).toBe(manual.id);
      const detail = await service.getDetail(manual.id);
      expect(detail).toMatchObject({
        nom: `${RUN} Championnat de France Seniors`,
        ville: "Orléans",
        lieu: "Palais des sports",
        saison: "2098",
        origin: "imported",
      });
      expect(detail.sources.map((s) => s.source).sort()).toEqual(["ekvara_manual", "fftda"]);
      await expect(service.update(manual.id, { ville: "Tours" }, ADMIN_ID)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("source d'import rattachée entre la lecture et l'écriture : la modification manuelle est refusée dans la transaction", async () => {
      const manual = await service.create({ nom: `${RUN} Open Concurrence`, dateDebut: "2098-10-03" }, ADMIN_ID);
      await prisma.competition_source.create({
        data: { competition_id: manual.id, source: "fftda", source_external_id: `${RUN}-race`, match_confidence: "safe" },
      });
      const before = await prisma.competition.findUniqueOrThrow({ where: { id: manual.id } });

      await expect(
        adminRepository.updateManual(manual.id, {
          nom: "Écrasée",
          organisateur: null,
          date_debut: before.date_debut,
          date_fin: null,
          lieu: null,
          ville: null,
          pays: null,
          niveau: null,
          saison: null,
        }),
      ).rejects.toBeInstanceOf(CompetitionNoLongerManualError);
      expect((await prisma.competition.findUniqueOrThrow({ where: { id: manual.id } })).nom).toBe(`${RUN} Open Concurrence`);
    });
  });

  describe("liste et statistiques", () => {
    it("recherche, filtre d'origine, année, tri et nombre de combats", async () => {
      const a = await service.create({ nom: `${RUN} Liste Alpha`, dateDebut: "2098-11-01", ville: "Nantes" }, ADMIN_ID);
      const b = await service.create({ nom: `${RUN} Liste Beta`, dateDebut: "2098-11-20" }, ADMIN_ID);
      await importFromFftda("list", `${RUN} Liste Gamma`, "2098-11-10");

      const all = await service.list({ search: `${RUN} Liste`, sort: "asc" });
      expect(all.items.map((i) => i.nom)).toEqual([`${RUN} Liste Alpha`, `${RUN} Liste Gamma`, `${RUN} Liste Beta`]);
      expect(all.items[0]).toMatchObject({ id: a.id, origin: "manual", matchCount: 0, ville: "Nantes" });

      const desc = await service.list({ search: `${RUN} Liste`, sort: "desc" });
      expect(desc.items[0].id).toBe(b.id);

      const manual = await service.list({ search: `${RUN} Liste`, origin: "manual" });
      expect(manual.items.map((i) => i.nom).sort()).toEqual([`${RUN} Liste Alpha`, `${RUN} Liste Beta`]);
      const imported = await service.list({ search: `${RUN} Liste`, origin: "imported" });
      expect(imported.items.map((i) => i.nom)).toEqual([`${RUN} Liste Gamma`]);

      expect((await service.list({ search: `${RUN} Liste`, year: 2097 })).total).toBe(0);
      const page = await service.list({ search: `${RUN} Liste`, limit: 2, page: 2, sort: "asc" });
      expect(page).toMatchObject({ total: 3, page: 2, limit: 2 });
      expect(page.items.map((i) => i.id)).toEqual([b.id]);
    });

    it("statistiques lues en base : cohérentes avec les comptages Prisma", async () => {
      const stats = await new AdminStatsService(prisma).getStats();
      expect(stats.totals.competitions).toBeGreaterThan(0);
      expect(stats.totals.competitionsWithoutResults).toBeLessThanOrEqual(stats.totals.competitions);
      expect(stats.totals.pastCompetitionsWithoutResults).toBeLessThanOrEqual(stats.totals.competitionsWithoutResults);
      expect(stats.recent.competitions.length).toBeLessThanOrEqual(5);
      expect(stats.recent.competitions[0]).toEqual(
        expect.objectContaining({ id: expect.any(String), nom: expect.any(String), origin: expect.stringMatching(/^(manual|imported)$/) }),
      );
    });
  });
});
