import { WtBackfillScope } from "./wt-backfill.service";

// Parsing PUR (aucun I/O) des arguments CLI en scope de discovery. Un scope
// est TOUJOURS obligatoire : jamais de backfill total implicite (ticket
// §Discovery — "si aucun scope: REFUSER de démarrer").
export function parseScopeArgs(args: string[]): WtBackfillScope {
  const get = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const year = get("year");
  const from = get("from");
  const to = get("to");
  const slugsArg = get("slugs");
  const yearsArg = get("years");

  if (slugsArg) {
    if (!yearsArg) throw new Error("--slugs exige --years=YYYY[,YYYY...] (où chercher ces événements)");
    return { kind: "slugs", slugs: slugsArg.split(",").filter(Boolean), years: yearsArg.split(",").map(Number) };
  }
  if (from || to) {
    if (!from || !to) throw new Error("--from et --to doivent être fournis ensemble (YYYY-MM-DD)");
    return { kind: "range", from, to };
  }
  if (year) {
    const y = Number(year);
    if (!Number.isInteger(y)) throw new Error("--year doit être un entier YYYY");
    return { kind: "year", year: y };
  }
  throw new Error("Scope obligatoire : --year=YYYY, ou --from=...--to=..., ou --slugs=...--years=... (aucun backfill total implicite)");
}
