import "dotenv/config";
import { PrismaService } from "../prisma/prisma.service";
import { CompetitionsRepository } from "./competitions.repository";
import { CompetitionsService } from "./competitions.service";
import { CompetitionEntriesRepository } from "./competition-entries.repository";
import { FftdaImporterService } from "./importers/fftda-importer.service";
import { MartialEventsImporterService } from "./importers/martial-events/me-importer.service";
import { WtImporterService } from "./importers/world-taekwondo/wt-importer.service";

// #22 — capture des divisions du calendrier WT sur les entrées déjà connues,
// jamais déclenché par HTTP :
//
//   npm run wt:calendar-divisions -- --year=2025 [--year=2026]
//
// N'écrit que competition_source.raw_divisions (voir
// CompetitionsService.refreshWorldTaekwondoDivisions).
function parseArgs(argv: string[]): number[] {
  const years: number[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--year=")) years.push(Number(arg.slice("--year=".length)));
    else throw new Error(`Argument inconnu: ${arg}`);
  }
  if (years.length === 0 || years.some((y) => !Number.isInteger(y))) throw new Error("--year=YYYY est obligatoire");
  return years;
}

async function main() {
  const years = parseArgs(process.argv.slice(2));
  const prisma = new PrismaService();
  try {
    const service = new CompetitionsService(
      new CompetitionsRepository(prisma),
      new CompetitionEntriesRepository(prisma),
      new FftdaImporterService(),
      new WtImporterService(),
      new MartialEventsImporterService(),
    );
    for (const year of years) {
      console.log(JSON.stringify(await service.refreshWorldTaekwondoDivisions(year), null, 2));
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
