import "dotenv/config";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { InternationalRepository } from "../../international/international.repository";
import { describeOnTestDatabase } from "../../test-utils/test-database";
import { AdminAuditLogger } from "../admin-audit.logger";
import { MANUAL_SOURCE } from "../competitions/admin-competition-origin";
import { AdminAthletesRepository, AthleteNoLongerManualError } from "./admin-athletes.repository";
import { AdminAthletesService } from "./admin-athletes.service";

const ADMIN_ID = "0b6f3c1e-2a4d-4e5f-9a7b-1c2d3e4f5a6b";
const WT_SOURCE = "world_taekwondo_results";

// Comptes EKVARA : le code testé ne doit JAMAIS lire ni écrire app_user /
// athlete, ni écrire athlete_wt_link (lecture du seul nombre de liens
// confirmés autorisée). Garantie structurelle, y compris dans les
// transactions : tout accès interdit lève immédiatement.
function guardAccounts<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, property) {
      if (property === "app_user" || property === "athlete") {
        throw new Error(`Accès interdit à la table ${String(property)} (compte EKVARA)`);
      }
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "athlete_wt_link") {
        return new Proxy(value as object, {
          get(delegate, method) {
            if (method !== "count") throw new Error(`Opération interdite sur athlete_wt_link : ${String(method)}`);
            return (Reflect.get(delegate, method, delegate) as (...args: unknown[]) => unknown).bind(delegate);
          },
        });
      }
      if (property === "$transaction") {
        const transaction = value as (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => Promise<unknown>;
        return (fn: (tx: unknown) => Promise<unknown>, options?: unknown) =>
          transaction.call(target, (tx: unknown) => fn(guardAccounts(tx as object)), options);
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

// Intégration Postgres réelle, UNIQUEMENT sur la base de test isolée
// (npm run test:testdb). Données marquées RUN, supprimées en afterAll
// (compétitions d'abord : les combats référencent les athlètes). L'import WT
// passe par le VRAI chemin (InternationalRepository.upsertAthleteFromSource).
describeOnTestDatabase("Athlètes internationaux EkvaraAdmin (intégration Postgres, base de test)", () => {
  const RUN = `AthIT${Date.now()}`;
  let prisma: PrismaService;
  let international: InternationalRepository;
  let repository: AdminAthletesRepository;
  let audit: AdminAuditLogger;
  let service: AdminAthletesService;

  beforeAll(() => {
    prisma = new PrismaService();
    const guarded = guardAccounts(prisma);
    international = new InternationalRepository(guarded);
    repository = new AdminAthletesRepository(guarded);
    audit = new AdminAuditLogger();
    service = new AdminAthletesService(repository, international, audit);
  });

  beforeEach(() => {
    jest.spyOn(audit, "record").mockImplementation(() => undefined);
    jest.spyOn(audit, "denied").mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await prisma.competition.deleteMany({ where: { nom: { contains: RUN } } });
    await prisma.external_athlete.deleteMany({ where: { display_name: { contains: RUN } } });
    await prisma.$disconnect();
  });

  const name = (label: string) => `${RUN} ${label}`;
  const countByName = (displayName: string) => prisma.external_athlete.count({ where: { display_name: displayName } });
  // Import WT par le chemin réel de l'importeur.
  const importFromWt = (externalId: string, displayName: string, countryCode?: string) =>
    new InternationalRepository(prisma).upsertAthleteFromSource({
      source: WT_SOURCE,
      sourceExternalId: `${RUN}-${externalId}`,
      sourceUrl: `https://worldtaekwondo.example/athletes/${externalId}`,
      displayName,
      countryCode,
    });

  describe("création", () => {
    it("crée external_athlete + provenance ekvara_manual ; inconnu reste NULL ; aucun compte EKVARA", async () => {
      const displayName = name("Minsu KIM");
      const profile = await service.create({ displayName, countryCode: "KOR" }, ADMIN_ID);

      expect(profile).toMatchObject({ displayName, countryCode: "KOR", gender: null, birthDate: null, origin: "manual", linkedAccounts: 0 });
      expect(profile.recordedStats).toMatchObject({ fights: 0, wins: 0, losses: 0 });
      const sources = await prisma.external_athlete_source.findMany({ where: { external_athlete_id: profile.id } });
      expect(sources).toHaveLength(1);
      expect(sources[0]).toMatchObject({ source: MANUAL_SOURCE, source_external_id: profile.id, raw_name: displayName, source_url: null });
      expect(audit.record).toHaveBeenCalledWith("admin.athlete.created", expect.objectContaining({ athleteId: profile.id, userId: ADMIN_ID }));
    });

    it("prévisualisation : aucune écriture", async () => {
      const displayName = name("Preview Only");
      const own = () => prisma.external_athlete.count({ where: { display_name: { contains: RUN } } });
      const before = await own();
      const preview = await service.previewCreate({ displayName });
      expect(preview.data).toEqual({ displayName, countryCode: null, gender: null, birthDate: null });
      expect(preview.warnings).toEqual([expect.stringContaining("Code pays non renseigné")]);
      expect(await own()).toBe(before);
    });

    it.each([
      ["date inexistante", "2004-02-30"],
      ["date future", "2999-01-01"],
      ["avant 1900", "1899-12-31"],
    ])("date de naissance invalide (%s) -> 400, rien n'est écrit", async (_label, birthDate) => {
      const displayName = name(`Invalid ${birthDate}`);
      await expect(service.create({ displayName, birthDate }, ADMIN_ID)).rejects.toBeInstanceOf(BadRequestException);
      expect(await countByName(displayName)).toBe(0);
    });

    it("transaction : si la provenance échoue, l'athlète n'est pas créé", async () => {
      const displayName = name("Transaction");
      const failing = new Proxy(prisma, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (property !== "$transaction") return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          return (fn: (tx: unknown) => Promise<unknown>) =>
            target.$transaction((tx) =>
              fn(
                new Proxy(tx, {
                  get(t, p) {
                    const v = Reflect.get(t, p, t) as unknown;
                    if (p !== "external_athlete_source") return v;
                    return { create: () => Promise.reject(new Error("échec simulé de la provenance")) };
                  },
                }),
              ),
            );
        },
      });
      const failingService = new AdminAthletesService(new AdminAthletesRepository(failing), international, audit);
      await expect(failingService.create({ displayName }, ADMIN_ID)).rejects.toThrow("échec simulé");
      expect(await countByName(displayName)).toBe(0);
    });
  });

  describe("doublons : signalés, jamais fusionnés", () => {
    it("même nom (ordre inversé) -> 409 ; confirmation explicite -> deux athlètes distincts", async () => {
      const first = await service.create({ displayName: name("Jiwoo LEE"), countryCode: "KOR" }, ADMIN_ID);

      const error = await service.create({ displayName: name("LEE Jiwoo"), countryCode: "KOR" }, ADMIN_ID).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      const body = (error as ConflictException).getResponse() as { candidates: { id: string; level: string }[] };
      expect(body.candidates).toEqual([expect.objectContaining({ id: first.id, level: "probable" })]);

      const second = await service.create({ displayName: name("LEE Jiwoo"), countryCode: "KOR", acknowledgedDuplicateIds: [first.id] }, ADMIN_ID);
      expect(second.id).not.toBe(first.id);
      expect(await prisma.external_athlete_source.count({ where: { external_athlete_id: first.id } })).toBe(1);
    });

    it("homonyme d'un athlète importé de WT, autre pays -> candidat « possible »", async () => {
      const imported = await importFromWt("homonym", name("Lucas MARTIN"), "BEL");
      const preview = await service.previewCreate({ displayName: name("Martin Lucas"), countryCode: "FRA" });
      expect(preview.candidates).toEqual([
        expect.objectContaining({ id: imported.athleteId, level: "possible", countryCode: "BEL", sources: [WT_SOURCE] }),
      ]);
    });
  });

  describe("modification", () => {
    it("athlète manuel : tous les champs modifiables, provenance brute mise à jour", async () => {
      const created = await service.create({ displayName: name("Emma DUBOIS") }, ADMIN_ID);
      const updated = await service.update(
        created.id,
        { displayName: name("Emma DUBOIS-ROY"), countryCode: "FRA", gender: "female", birthDate: "2003-07-14" },
        ADMIN_ID,
      );
      expect(updated).toMatchObject({ displayName: name("Emma DUBOIS-ROY"), countryCode: "FRA", gender: "female", birthDate: "2003-07-14" });
      const source = await prisma.external_athlete_source.findFirstOrThrow({ where: { external_athlete_id: created.id } });
      expect(source.raw_name).toBe(name("Emma DUBOIS-ROY"));
      expect(audit.record).toHaveBeenCalledWith("admin.athlete.updated", expect.objectContaining({ athleteId: created.id, origin: "manual" }));
    });

    it("athlète importé de WT : nom et pays refusés (403) ; genre et date de naissance acceptés ; source WT intacte", async () => {
      const { athleteId } = await importFromWt("enrich", name("Ahmad ABUGHAUSH"), "JOR");
      const sourceBefore = await prisma.external_athlete_source.findFirstOrThrow({ where: { external_athlete_id: athleteId } });

      await expect(service.update(athleteId, { displayName: "Renommé" }, ADMIN_ID)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.update(athleteId, { countryCode: "FRA" }, ADMIN_ID)).rejects.toBeInstanceOf(ForbiddenException);
      const enriched = await service.update(athleteId, { gender: "male", birthDate: "1996-02-01" }, ADMIN_ID);

      expect(enriched).toMatchObject({ displayName: name("Ahmad ABUGHAUSH"), countryCode: "JOR", gender: "male", birthDate: "1996-02-01", origin: "imported" });
      const sourceAfter = await prisma.external_athlete_source.findFirstOrThrow({ where: { external_athlete_id: athleteId } });
      expect(sourceAfter).toEqual(sourceBefore);
    });

    it("ré-import WT après enrichissement : même athlète, nom WT conservé, genre/date de naissance conservés", async () => {
      const { athleteId } = await importFromWt("reimport", name("Zhao SHUAI"));
      await service.update(athleteId, { gender: "male", birthDate: "1995-08-15" }, ADMIN_ID);

      const again = await importFromWt("reimport", name("Zhao SHUAI"), "CHN");
      expect(again).toEqual({ athleteId, created: false });
      const row = await prisma.external_athlete.findUniqueOrThrow({ where: { id: athleteId } });
      expect(row).toMatchObject({ display_name: name("Zhao SHUAI"), country_code: "CHN", gender: "male" });
      expect(row.birth_date?.toISOString().slice(0, 10)).toBe("1995-08-15");
    });

    it("source WT rattachée entre lecture et écriture : la modification manuelle est refusée dans la transaction", async () => {
      const created = await service.create({ displayName: name("Race Condition") }, ADMIN_ID);
      await prisma.external_athlete_source.create({
        data: { external_athlete_id: created.id, source: WT_SOURCE, source_external_id: `${RUN}-race` },
      });
      await expect(
        repository.updateManual(created.id, { display_name: "Écrasé", country_code: null, gender: null, birth_date: null }),
      ).rejects.toBeInstanceOf(AthleteNoLongerManualError);
      expect((await prisma.external_athlete.findUniqueOrThrow({ where: { id: created.id } })).display_name).toBe(name("Race Condition"));
    });
  });

  describe("liste et profil", () => {
    it("recherche, pays, origine, nombre de combats ; profil avec bilan et derniers combats", async () => {
      const a = await service.create({ displayName: name("Liste Alpha"), countryCode: "FRA" }, ADMIN_ID);
      const b = await service.create({ displayName: name("Liste Beta"), countryCode: "ESP" }, ADMIN_ID);
      await importFromWt("list", name("Liste Gamma"), "FRA");

      const competition = await prisma.competition.create({ data: { nom: name("Open Liste"), date_debut: new Date("2098-02-02T00:00:00Z") } });
      await prisma.competition_match.create({
        data: {
          competition_id: competition.id,
          source: MANUAL_SOURCE,
          source_external_id: `${RUN}-match`,
          athlete_a_id: a.id,
          athlete_b_id: b.id,
          score_a: 2,
          score_b: 1,
          winner_athlete_id: a.id,
          category_label: "Men -58kg",
          bracket_stage: "F",
        },
      });

      const all = await service.list({ search: name("Liste") });
      expect(all.items.map((i) => i.displayName)).toEqual([name("Liste Alpha"), name("Liste Beta"), name("Liste Gamma")]);
      expect(all.items[0]).toMatchObject({ id: a.id, fightCount: 1, origin: "manual" });

      expect((await service.list({ search: name("Liste"), country: "FRA" })).items.map((i) => i.displayName)).toEqual([
        name("Liste Alpha"),
        name("Liste Gamma"),
      ]);
      expect((await service.list({ search: name("Liste"), origin: "imported" })).items.map((i) => i.displayName)).toEqual([name("Liste Gamma")]);
      expect(await service.list({ search: name("Liste"), limit: 2, page: 2 })).toMatchObject({ total: 3, page: 2 });
      expect((await service.countries()).countries).toEqual(expect.arrayContaining(["ESP", "FRA"]));

      const profile = await service.getProfile(a.id);
      expect(profile.recordedStats).toMatchObject({ fights: 1, wins: 1, losses: 0, competitions: 1, winRate: 100 });
      expect(profile.recentFights).toEqual([
        expect.objectContaining({
          competitionName: name("Open Liste"),
          opponent: expect.objectContaining({ id: b.id }),
          result: expect.objectContaining({ outcome: "WIN", athleteScore: 2, opponentScore: 1 }),
        }),
      ]);
    });
  });
});
