import "dotenv/config";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { CompetitionEntriesRepository } from "../../competitions/competition-entries.repository";
import { CompetitionEntriesService } from "../../competitions/competition-entries.service";
import { CompetitionsRepository } from "../../competitions/competitions.repository";
import { InternationalRepository } from "../../international/international.repository";
import { InternationalService } from "../../international/international.service";
import { describeOnTestDatabase } from "../../test-utils/test-database";
import { AdminAuditLogger } from "../admin-audit.logger";
import { MANUAL_SOURCE } from "../competitions/admin-competition-origin";
import { AdminEntriesRepository } from "../entries/admin-entries.repository";
import { AdminEntriesService } from "../entries/admin-entries.service";
import { AdminMatchesRepository } from "./admin-matches.repository";
import { AdminMatchesService } from "./admin-matches.service";

const ADMIN_ID = "0b6f3c1e-2a4d-4e5f-9a7b-1c2d3e4f5a6b";
const WT = "world_taekwondo_results";

// Le code testé ne doit JAMAIS toucher aux comptes EKVARA (app_user,
// athlete, participation) : garantie structurelle, transactions comprises.
function guardAccounts<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, property) {
      if (property === "app_user" || property === "athlete" || property === "participation") {
        throw new Error(`Accès interdit à la table ${String(property)} (compte EKVARA)`);
      }
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "$transaction") {
        const transaction = value as (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => Promise<unknown>;
        return (fn: (tx: unknown) => Promise<unknown>, options?: unknown) =>
          transaction.call(target, (tx: unknown) => fn(guardAccounts(tx as object)), options);
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

// Intégration Postgres réelle, UNIQUEMENT sur la base de test isolée.
// Données marquées RUN (compétition en 2097), supprimées en afterAll :
// compétition d'abord (inscrits et combats en cascade), puis athlètes.
describeOnTestDatabase("Participants et combats EkvaraAdmin (intégration Postgres, base de test)", () => {
  const RUN = `ResIT${Date.now()}`;
  let prisma: PrismaService;
  let entries: AdminEntriesService;
  let matches: AdminMatchesService;
  let wt: InternationalRepository;
  let competitionId: string;
  // Une paire d'athlètes distincte par scénario : une même paire déjà présente
  // dans la compétition est (à juste titre) signalée comme doublon possible.
  const athlete: Record<"a" | "b" | "c" | "d" | "e", string> = { a: "", b: "", c: "", d: "", e: "" };

  beforeAll(async () => {
    prisma = new PrismaService();
    const guarded = guardAccounts(prisma);
    const audit = new AdminAuditLogger();
    jest.spyOn(audit, "record").mockImplementation(() => undefined);
    entries = new AdminEntriesService(new AdminEntriesRepository(guarded), audit);
    matches = new AdminMatchesService(new AdminMatchesRepository(guarded), new InternationalRepository(guarded), audit);
    wt = new InternationalRepository(prisma);
    competitionId = (await prisma.competition.create({ data: { nom: `${RUN} Open`, date_debut: new Date("2097-03-14T00:00:00Z"), date_fin: new Date("2097-03-15T00:00:00Z") } })).id;
    for (const key of ["a", "b", "c", "d", "e"] as const) {
      athlete[key] = (await wt.upsertAthleteFromSource({ source: WT, sourceExternalId: `${RUN}-${key}`, displayName: `${RUN} Athlete ${key.toUpperCase()}` })).athleteId;
    }
  });

  afterAll(async () => {
    await prisma.competition.deleteMany({ where: { nom: { contains: RUN } } });
    await prisma.external_athlete.deleteMany({ where: { display_name: { contains: RUN } } });
    await prisma.$disconnect();
  });

  const match = (extra: Record<string, unknown> = {}) => ({ category: "Men -58kg", athleteAId: athlete.a, athleteBId: athlete.b, ...extra });
  // Combat WT par le chemin réel de l'importeur.
  const importWtMatch = (externalId: string, extra: Record<string, unknown> = {}) =>
    wt.saveMatchRepresentation({
      competitionId,
      source: WT,
      sourceExternalId: `${RUN}-${externalId}`,
      categoryLabel: "Men -68kg",
      contestNumber: 7,
      bracketStage: "SF",
      athleteAId: athlete.a,
      athleteBId: athlete.c,
      scoreA: 2,
      scoreB: 0,
      winnerAthleteId: athlete.a,
      resultMethod: "PTF",
      ...extra,
    });

  describe("participants", () => {
    it("création manuelle (inconnu -> NULL), visible par l'endpoint public existant", async () => {
      const created = await entries.create(competitionId, { participantName: `${RUN} Emma DUBOIS`, category: "Seniors F -57kg", country: "France" }, ADMIN_ID);
      expect(created).toMatchObject({ source: MANUAL_SOURCE, origin: "manual", club: null, gender: null, ageCategory: null, league: null });

      const publicView = await new CompetitionEntriesService(new CompetitionsRepository(prisma), new CompetitionEntriesRepository(prisma)).findByCompetition(competitionId);
      expect(publicView.categories).toEqual([
        expect.objectContaining({ rawLabel: "Seniors F -57kg", entries: [expect.objectContaining({ id: created.id, country: "France" })] }),
      ]);
    });

    it("doublon exact d'un participant manuel -> 409 non confirmable ; homonyme d'un inscrit importé -> confirmation exigée", async () => {
      const name = `${RUN} Lea MARTIN`;
      const first = await entries.create(competitionId, { participantName: name, category: "Cadets F -44kg" }, ADMIN_ID);
      const exact = await entries.create(competitionId, { participantName: name, category: "Cadets F -44kg", acknowledgedDuplicateIds: [first.id] }, ADMIN_ID).catch((e: unknown) => e);
      expect(exact).toBeInstanceOf(ConflictException);
      expect((exact as ConflictException).getResponse()).toMatchObject({ blocking: true });

      const imported = await prisma.competition_entry.create({
        data: { competition_id: competitionId, source: "martial_events", participant_name: `${RUN} Hugo PETIT`, source_category_raw_label: "Juniors M -55kg" },
      });
      const preview = await entries.previewCreate(competitionId, { participantName: `${RUN} PETIT Hugo`, category: "Juniors M -55kg" });
      expect(preview).toMatchObject({ blocking: null, candidates: [expect.objectContaining({ id: imported.id, level: "probable", source: "martial_events" })] });
      await expect(entries.create(competitionId, { participantName: `${RUN} PETIT Hugo`, category: "Juniors M -55kg" }, ADMIN_ID)).rejects.toBeInstanceOf(ConflictException);
      const confirmed = await entries.create(competitionId, { participantName: `${RUN} PETIT Hugo`, category: "Juniors M -55kg", acknowledgedDuplicateIds: [imported.id] }, ADMIN_ID);
      expect(confirmed.id).not.toBe(imported.id);
    });

    it("modification : manuel modifiable ; importé refusé (403) et intact", async () => {
      const created = await entries.create(competitionId, { participantName: `${RUN} Nina ROSE`, category: "Seniors F -49kg" }, ADMIN_ID);
      expect(await entries.update(created.id, { participantName: `${RUN} Nina ROSE`, category: "Seniors F -49kg", club: "TKD Eaubonne" }, ADMIN_ID)).toMatchObject({ club: "TKD Eaubonne" });

      const imported = await prisma.competition_entry.create({
        data: { competition_id: competitionId, source: "martial_events", participant_name: `${RUN} Imported`, source_category_raw_label: "Seniors M -80kg", club: "Club A" },
      });
      await expect(entries.update(imported.id, { participantName: `${RUN} Imported`, category: "Seniors M -80kg", club: "Club B" }, ADMIN_ID)).rejects.toBeInstanceOf(ForbiddenException);
      expect((await prisma.competition_entry.findUniqueOrThrow({ where: { id: imported.id } })).club).toBe("Club A");
    });

    it("synchronisation Martial Events : ne touche jamais les participants manuels", async () => {
      const manual = await entries.create(competitionId, { participantName: `${RUN} Survivor`, category: "Seniors M -63kg" }, ADMIN_ID);
      const result = await new CompetitionEntriesRepository(prisma).syncForCompetition(competitionId, "martial_events", []);
      expect(result.removed).toBeGreaterThan(0);
      expect(await prisma.competition_entry.count({ where: { competition_id: competitionId, source: "martial_events" } })).toBe(0);
      expect(await prisma.competition_entry.findUnique({ where: { id: manual.id } })).not.toBeNull();
    });
  });

  describe("combats", () => {
    it("création manuelle : représentation ekvara_manual, inconnu -> NULL, vainqueur jamais déduit du score", async () => {
      const preview = await matches.previewCreate(competitionId, match({ scoreA: 3, scoreB: 0, contestNumber: 11 }));
      expect(preview.data).toMatchObject({ winnerSide: null, method: null, stage: null });
      expect(preview.warnings).toEqual(expect.arrayContaining([expect.stringContaining("jamais déduit du score")]));

      const created = await matches.create(competitionId, match({ scoreA: 3, scoreB: 0, contestNumber: 11 }), ADMIN_ID);
      expect(created).toMatchObject({ winnerSide: null, method: null, stage: null, occurredOn: null, origin: "manual", editable: true });
      const row = await prisma.competition_match.findUniqueOrThrow({ where: { id: created.id }, include: { sources: true } });
      expect(row).toMatchObject({ source: MANUAL_SOURCE, source_external_id: created.id, winner_athlete_id: null, result_method_raw: null });
      expect(row.sources).toEqual([expect.objectContaining({ source: MANUAL_SOURCE, source_external_id: created.id })]);
    });

    it("règles métier : même athlète des deux côtés, athlète inexistant -> 400 sans écriture", async () => {
      const before = await prisma.competition_match.count({ where: { competition_id: competitionId } });
      await expect(matches.create(competitionId, match({ athleteBId: athlete.a }), ADMIN_ID)).rejects.toBeInstanceOf(BadRequestException);
      await expect(matches.create(competitionId, match({ athleteBId: "00000000-0000-4000-8000-000000000000" }), ADMIN_ID)).rejects.toBeInstanceOf(BadRequestException);
      expect(await prisma.competition_match.count({ where: { competition_id: competitionId } })).toBe(before);
    });

    it("vainqueur : côté B enregistré tel quel même avec un score inférieur (avertissement, aucune correction)", async () => {
      const created = await matches.create(
        competitionId,
        match({ category: "Men -54kg", athleteAId: athlete.d, athleteBId: athlete.e, scoreA: 5, scoreB: 2, winner: "B", resultMethod: "DSQ" }),
        ADMIN_ID,
      );
      expect(created).toMatchObject({ winnerSide: "B", method: "DSQ" });
      expect((await prisma.competition_match.findUniqueOrThrow({ where: { id: created.id } })).winner_athlete_id).toBe(athlete.e);
    });

    it("combat WT identique -> 409 non confirmable ; en conflit -> deux versions présentées, confirmation exigée, jamais fusionné", async () => {
      const imported = await importWtMatch("sf7");
      const same = match({ category: "Men -68kg", contestNumber: 7, bracketStage: "SF", athleteBId: athlete.c, scoreA: 2, scoreB: 0, winner: "A", resultMethod: "PTF" });

      const identical = await matches.create(competitionId, { ...same, acknowledgedDuplicateIds: [imported.matchId] }, ADMIN_ID).catch((e: unknown) => e);
      expect(identical).toBeInstanceOf(ConflictException);
      expect((identical as ConflictException).getResponse()).toMatchObject({ blocking: true, candidates: [expect.objectContaining({ level: "identical" })] });

      const conflicting = { ...same, scoreA: 1, scoreB: 2, winner: "B" as const };
      const preview = await matches.previewCreate(competitionId, conflicting);
      expect(preview.candidates).toEqual([
        expect.objectContaining({
          level: "conflict",
          differences: expect.arrayContaining(["scoreA", "scoreB", "winner"]),
          match: expect.objectContaining({ id: imported.matchId, origin: "imported", scoreA: 2, scoreB: 0, winnerSide: "A" }),
        }),
      ]);
      await expect(matches.create(competitionId, conflicting, ADMIN_ID)).rejects.toBeInstanceOf(ConflictException);
      const created = await matches.create(competitionId, { ...conflicting, acknowledgedDuplicateIds: [imported.matchId] }, ADMIN_ID);
      expect(created.id).not.toBe(imported.matchId);
      const wtRow = await prisma.competition_match.findUniqueOrThrow({ where: { id: imported.matchId }, include: { sources: true } });
      expect(wtRow).toMatchObject({ score_a: 2, score_b: 0, winner_athlete_id: athlete.a });
      expect(wtRow.sources).toHaveLength(1);
    });

    it("combat WT en lecture seule : 403, aucune modification", async () => {
      const imported = await importWtMatch("ro", { categoryLabel: "Men -74kg", contestNumber: 3 });
      await expect(
        matches.update(imported.matchId, match({ category: "Men -74kg", contestNumber: 3, athleteBId: athlete.c, scoreA: 0, scoreB: 2, winner: "B" }), ADMIN_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect((await prisma.competition_match.findUniqueOrThrow({ where: { id: imported.matchId } })).winner_athlete_id).toBe(athlete.a);
    });

    it("modification d'un combat manuel ; puis import WT du même combat : rattaché (règle existante), le combat devient lecture seule", async () => {
      const pair = { athleteAId: athlete.b, athleteBId: athlete.c };
      const created = await matches.create(competitionId, match({ ...pair, category: "Men -87kg", contestNumber: 21, bracketStage: "QF" }), ADMIN_ID);
      const updated = await matches.update(
        created.id,
        match({ ...pair, category: "Men -87kg", contestNumber: 21, bracketStage: "QF", scoreA: 2, scoreB: 1, winner: "A", resultMethod: "PTF", occurredOn: "2097-03-14" }),
        ADMIN_ID,
      );
      expect(updated).toMatchObject({ scoreA: 2, scoreB: 1, winnerSide: "A", method: "PTF", occurredOn: "2097-03-14" });

      const attached = await wt.saveMatchRepresentation({
        competitionId,
        source: WT,
        sourceExternalId: `${RUN}-qf21`,
        categoryLabel: "Men -87kg",
        contestNumber: 21,
        bracketStage: "QF",
        athleteAId: athlete.b,
        athleteBId: athlete.c,
        scoreA: 2,
        scoreB: 1,
        winnerAthleteId: athlete.b,
        resultMethod: "PTF",
      });
      expect(attached).toMatchObject({ matchId: created.id, outcome: "attached", created: false });
      expect(await matches.get(created.id)).toMatchObject({ origin: "imported", editable: false });
      await expect(matches.update(created.id, match({ ...pair, category: "Men -87kg", contestNumber: 21 }), ADMIN_ID)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("résultats publics existants : les combats manuels apparaissent, sans régression", async () => {
      const summary = await new InternationalService(new InternationalRepository(prisma)).getCompetitionResultsSummary(competitionId);
      expect(summary.categories.map((c) => c.label)).toEqual(expect.arrayContaining(["Men -58kg", "Men -68kg"]));
      const admin = await matches.summary(competitionId);
      expect(admin.matchCount).toBe(summary.matchCount);
      const list = await matches.listCategory(competitionId, "Men -68kg");
      expect(list.items.map((m) => m.origin).sort()).toEqual(["imported", "manual"]);
    });
  });
});
