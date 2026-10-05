import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { CompetitionsRepository } from "./competitions.repository";
import { CompetitionsService } from "./competitions.service";
import { CompetitionEntriesRepository } from "./competition-entries.repository";
import { FftdaImporterService } from "./importers/fftda-importer.service";
import { MartialEventsImporterService } from "./importers/martial-events/me-importer.service";
import { WtImporterService } from "./importers/world-taekwondo/wt-importer.service";

// Imports de catalogue en production (les routes HTTP sont fermées, voir
// HttpImportsGuard) — mêmes services que POST /competitions/import/* :
//
//   npm run import:competitions -- fftda
//   npm run import:competitions -- world-taekwondo --year=2026
//   npm run import:competitions -- martial-events
type Source = "fftda" | "world-taekwondo" | "martial-events";

function parseArgs(argv: string[]): { source: Source; year: number } {
  const [source, ...rest] = argv;
  if (source !== "fftda" && source !== "world-taekwondo" && source !== "martial-events") {
    throw new Error("Source attendue : fftda | world-taekwondo | martial-events");
  }
  let year = new Date().getFullYear();
  for (const arg of rest) {
    if (arg.startsWith("--year=") && source === "world-taekwondo") year = Number(arg.slice("--year=".length));
    else throw new Error(`Argument inconnu: ${arg}`);
  }
  if (!Number.isInteger(year)) throw new Error("--year=YYYY invalide");
  return { source, year };
}

async function main() {
  const { source, year } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaService();
  try {
    const service = new CompetitionsService(
      new CompetitionsRepository(prisma),
      new CompetitionEntriesRepository(prisma),
      new FftdaImporterService(),
      new WtImporterService(),
      new MartialEventsImporterService(),
    );
    const summary =
      source === "fftda"
        ? await service.importFftda()
        : source === "world-taekwondo"
          ? await service.importWorldTaekwondo(year)
          : await service.importMartialEvents();
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
