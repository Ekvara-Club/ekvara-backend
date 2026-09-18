import "dotenv/config";
import { PrismaService } from "../../prisma/prisma.service";
import { InternationalRepository } from "../international.repository";
import { WorldTaekwondoResultsImporterService } from "./wt-results-importer.service";
import { MAX_PILOT_COMPETITIONS, WtResultsImportService } from "./wt-results-import.service";

// POC contrôlé "WT Results Data Foundation V1" — jamais déclenché par HTTP.
//
//   npm run import:wt-results -- --year=2026 \
//     --slug=roma-2026-world-taekwondo-grand-prix \
//     --category="Men -68kg" [--max-matches=60] [--profiles=uuid,uuid] [--refresh]
//     [--mapping-only]   (calcule et affiche le mapping, n'écrit rien)
//
// Au plus 3 --slug. Pas de mode "tout importer" : le backfill global exige une
// validation explicite et un ticket séparé.
function parseArgs(argv: string[]) {
  const slugs: string[] = [];
  let year: number | undefined;
  let categoryLabel: string | undefined;
  let maxMatches: number | undefined;
  let profileAthleteIds: string[] = [];
  let refreshExisting = false;
  let mappingOnly = false;

  for (const arg of argv) {
    if (arg.startsWith("--slug=")) slugs.push(arg.slice("--slug=".length));
    else if (arg.startsWith("--year=")) year = Number(arg.slice("--year=".length));
    else if (arg.startsWith("--category=")) categoryLabel = arg.slice("--category=".length);
    else if (arg.startsWith("--max-matches=")) maxMatches = Number(arg.slice("--max-matches=".length));
    else if (arg.startsWith("--profiles=")) profileAthleteIds = arg.slice("--profiles=".length).split(",").filter(Boolean);
    else if (arg === "--refresh") refreshExisting = true;
    else if (arg === "--mapping-only") mappingOnly = true;
    else throw new Error(`Argument inconnu: ${arg}`);
  }

  if (!year || !Number.isInteger(year)) throw new Error("--year=YYYY est obligatoire");
  if (slugs.length === 0 || slugs.length > MAX_PILOT_COMPETITIONS) {
    throw new Error(`Fournir entre 1 et ${MAX_PILOT_COMPETITIONS} --slug=...`);
  }
  if (maxMatches !== undefined && (!Number.isInteger(maxMatches) || maxMatches < 1)) {
    throw new Error("--max-matches doit être un entier >= 1");
  }

  return { year, slugs, categoryLabel, maxMatchesPerCompetition: maxMatches, profileAthleteIds, refreshExisting, mappingOnly };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaService();
  try {
    const service = new WtResultsImportService(
      new WorldTaekwondoResultsImporterService(),
      new InternationalRepository(prisma),
    );
    const report = await service.runPilot(options);
    console.log(JSON.stringify(report, null, 2));
    if (report.aborted) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Échec de l'import WT Results:", error instanceof Error ? error.message : error);
  process.exit(1);
});
