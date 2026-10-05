import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsRepository } from "../notifications/notifications.repository";
import { CompetitionsRepository } from "../competitions/competitions.repository";
import { CompetitionsService } from "../competitions/competitions.service";
import { CompetitionEntriesRepository } from "../competitions/competition-entries.repository";
import { FftdaImporterService } from "../competitions/importers/fftda-importer.service";
import { MartialEventsImporterService } from "../competitions/importers/martial-events/me-importer.service";
import { WtImporterService } from "../competitions/importers/world-taekwondo/wt-importer.service";
import { InternationalRepository } from "../international/international.repository";
import { WorldTaekwondoResultsImporterService } from "../international/wt-results/wt-results-importer.service";
import { WtResultsImportService } from "../international/wt-results/wt-results-import.service";
import { WtBackfillRepository } from "../international/wt-backfill/wt-backfill.repository";
import { WtBackfillService } from "../international/wt-backfill/wt-backfill.service";
import { ChangedCompetition, describeChanges, notifyCompetitionChanges, selectRecentWtSlugs } from "./sources-sync";

// Synchro des sources, lancée tous les 3 jours par cron sur le Pi
// (deploy/sync-sources.sh) :
//
//   npm run sync:sources
//
// 1. Compétitions : FFTDA, calendrier WT (année en cours + suivante),
//    Martial Events. Nouvelles compétitions créées ; date/lieu modifiés à la
//    source reportés (source unique, jamais le nom) et notifiés aux athlètes
//    inscrits et aux coachs qui les préparent.
// 2. Athlètes : résultats World Taekwondo des compétitions terminées depuis
//    30 jours (nouveaux combats, profils, bilans), via le pipeline de
//    backfill existant — jamais un événement déjà présent dans un run.
// Une source en échec n'arrête jamais les autres ; tout est résumé en fin
// de journal.

function line(text: string) {
  console.log(`[sync ${new Date().toISOString()}] ${text}`);
}

async function main() {
  const prisma = new PrismaService();
  const notifications = new NotificationsRepository(prisma);
  const competitions = new CompetitionsService(
    new CompetitionsRepository(prisma),
    new CompetitionEntriesRepository(prisma),
    new FftdaImporterService(),
    new WtImporterService(),
    new MartialEventsImporterService(),
  );
  const year = new Date().getUTCFullYear();
  const changed: ChangedCompetition[] = [];
  let errors = 0;

  async function step(label: string, run: () => Promise<{ imported?: number; updated?: number; failed?: number; changed?: ChangedCompetition[] }>) {
    try {
      const summary = await run();
      changed.push(...(summary.changed ?? []));
      line(`${label} : ${summary.imported ?? 0} nouvelle(s), ${summary.changed?.length ?? 0} modifiée(s), ${summary.failed ?? 0} échec(s)`);
    } catch (error) {
      errors++;
      line(`${label} : ÉCHEC — ${(error as Error).message}`);
    }
  }

  try {
    line("Début de la synchro des sources");
    await step("FFTDA", () => competitions.importFftda());
    await step(`World Taekwondo ${year}`, () => competitions.importWorldTaekwondo(year));
    await step(`World Taekwondo ${year + 1}`, () => competitions.importWorldTaekwondo(year + 1));
    await step("Martial Events", () => competitions.importMartialEvents());

    for (const item of changed) line(`  modifiée : « ${item.nom} » — ${describeChanges(item.changes)}`);
    if (changed.length > 0) {
      const sent = await notifyCompetitionChanges(prisma, notifications, changed);
      line(`${sent} notification(s) envoyée(s) pour ${changed.length} compétition(s) modifiée(s)`);
    }

    // --- Athlètes : résultats WT récents --------------------------------
    try {
      const importer = new WorldTaekwondoResultsImporterService();
      const internationalRepo = new InternationalRepository(prisma);
      const backfill = new WtBackfillService(
        new WtBackfillRepository(prisma),
        internationalRepo,
        importer,
        new WtResultsImportService(importer, internationalRepo),
      );
      const now = new Date();
      const years = [...new Set([year, new Date(now.getTime() - 30 * 86_400_000).getUTCFullYear()])];
      const items = (await Promise.all(years.map((y) => importer.fetchCompetitionList(y)))).flat();
      const slugs = items.map((i) => i.slug);
      const [imported, queued] = await Promise.all([
        prisma.competition_source.findMany({ where: { source: "world_taekwondo_results", source_external_id: { in: slugs } }, select: { source_external_id: true } }),
        prisma.wt_backfill_event.findMany({ where: { slug: { in: slugs } }, select: { slug: true } }),
      ]);
      const selected = selectRecentWtSlugs(
        items,
        new Set(imported.map((r) => r.source_external_id)),
        new Set(queued.map((r) => r.slug)),
        now,
      );
      if (selected.length === 0) {
        line("Résultats WT : aucune nouvelle compétition terminée à importer");
      } else {
        line(`Résultats WT : ${selected.length} compétition(s) à importer — ${selected.join(", ")}`);
        const { runId } = await backfill.discover({ kind: "slugs", years, slugs: selected });
        const run = await backfill.start(runId);
        line(`Résultats WT : run ${runId} terminé (${JSON.stringify(run).slice(0, 300)})`);
      }
    } catch (error) {
      errors++;
      line(`Résultats WT : ÉCHEC — ${(error as Error).message}`);
    }

    line(`Fin de la synchro : ${changed.length} compétition(s) modifiée(s), ${errors} source(s) en échec`);
    if (errors > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
