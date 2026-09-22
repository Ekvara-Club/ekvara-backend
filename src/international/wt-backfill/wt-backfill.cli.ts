import "dotenv/config";
import { PrismaService } from "../../prisma/prisma.service";
import { InternationalRepository } from "../international.repository";
import { WorldTaekwondoResultsImporterService } from "../wt-results/wt-results-importer.service";
import { WtResultsImportService } from "../wt-results/wt-results-import.service";
import { WtBackfillRepository } from "./wt-backfill.repository";
import { WtBackfillService } from "./wt-backfill.service";
import { parseScopeArgs } from "./wt-backfill-scope";

// Moteur d'orchestration #12E — n'importe rien lui-même, appelle le pipeline
// WT Results existant (#12B/C/D, inchangé) événement par événement.
//
//   npm run wt:backfill -- discover --year=2026
//   npm run wt:backfill -- discover --from=2026-01-01 --to=2026-03-31
//   npm run wt:backfill -- discover --years=2026 --slugs=slug-a,slug-b
//   npm run wt:backfill -- start <run-id>
//   npm run wt:backfill -- status <run-id>
//   npm run wt:backfill -- resume <run-id>
//   npm run wt:backfill -- retry <event-id>
//
// discover est TOUJOURS "dry-run" : aucune écriture competition_match /
// external_athlete, uniquement la queue de suivi #12E (wt_backfill_run /
// wt_backfill_event). start est ce qui exécute réellement le pipeline.

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) {
    console.error("Usage: wt-backfill <discover|start|status|resume|retry> ...");
    process.exit(1);
  }

  const prisma = new PrismaService();
  const internationalRepo = new InternationalRepository(prisma);
  const importer = new WorldTaekwondoResultsImporterService();
  const importService = new WtResultsImportService(importer, internationalRepo);
  const backfillRepo = new WtBackfillRepository(prisma);
  const service = new WtBackfillService(backfillRepo, internationalRepo, importer, importService);

  let stopRequested = false;
  const shouldStop = () => stopRequested;
  const onSignal = (signal: string) => {
    if (stopRequested) return; // deuxième signal : on n'insiste pas, laisse le process se terminer normalement
    console.error(`\n[wt-backfill] ${signal} reçu — arrêt propre après la catégorie en cours (pas de nouvel événement).`);
    stopRequested = true;
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  try {
    switch (command) {
      case "discover": {
        const scope = parseScopeArgs(rest);
        const result = await service.discover(scope);
        console.log(JSON.stringify(result, null, 2));
        console.log(`\n${result.events.length} événement(s) découvert(s) — run ${result.runId} (queue figée, aucune donnée métier écrite).`);
        break;
      }
      case "start": {
        const runId = rest[0];
        if (!runId) throw new Error("start exige <run-id>");
        const run = await service.start(runId, shouldStop);
        console.log(JSON.stringify(run, null, 2));
        break;
      }
      case "resume": {
        const runId = rest[0];
        if (!runId) throw new Error("resume exige <run-id>");
        const run = await service.resume(runId, shouldStop);
        console.log(JSON.stringify(run, null, 2));
        break;
      }
      case "status": {
        const runId = rest[0];
        if (!runId) throw new Error("status exige <run-id>");
        const result = await service.status(runId);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "retry": {
        const eventId = rest[0];
        if (!eventId) throw new Error("retry exige <event-id>");
        await service.retryEvent(eventId);
        console.log(`Event ${eventId} remis en PENDING (résumer le run pour le retraiter).`);
        break;
      }
      default:
        throw new Error(`Commande inconnue: ${command}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Échec wt-backfill:", error instanceof Error ? error.message : error);
  process.exit(1);
});
