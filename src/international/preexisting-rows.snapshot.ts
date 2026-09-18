import { PrismaService } from "../prisma/prisma.service";

// Garanties "aucun impact sur l'existant" pour les tests d'intégration.
//
// Jest exécute les suites en parallèle sur la MÊME base : d'autres suites
// créent et suppriment leurs propres athlètes/participations/entries pendant
// qu'un test de cette suite s'exécute (constaté : 13 → 18 athlètes en cours de
// test). Un hash de table entière est donc instable. Deux garanties
// déterministes à la place :
//
//   1. forbidTables() — le code testé reçoit un client Prisma qui LÈVE une
//      erreur au premier accès à l'une des tables interdites : il est
//      structurellement impossible qu'il les lise ou les écrive ;
//   2. snapshotRows()/expectRowsUnchanged() — toute ligne présente avant ET
//      après doit être strictement identique (les lignes ajoutées ou retirées
//      par des suites concurrentes sont ignorées).

export type ForbiddenTable = "participation" | "competition_entry" | "athlete";
const WATCHED: ForbiddenTable[] = ["participation", "competition_entry", "athlete"];

export function forbidTables(prisma: PrismaService, forbidden: ForbiddenTable[]): PrismaService {
  const blocked = new Set<string>(forbidden);
  return new Proxy(prisma, {
    get(target, prop) {
      if (typeof prop === "string" && blocked.has(prop)) {
        throw new Error(`Accès interdit à la table "${prop}" par le code sous test`);
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export type RowSnapshot = Record<ForbiddenTable, Map<string, string>>;

export async function snapshotRows(prisma: PrismaService): Promise<RowSnapshot> {
  const toMap = (rows: { id: string }[]) => new Map(rows.map((row) => [row.id, JSON.stringify(row)]));
  return {
    participation: toMap(await prisma.participation.findMany()),
    competition_entry: toMap(await prisma.competition_entry.findMany()),
    athlete: toMap(await prisma.athlete.findMany()),
  };
}

// Retourne les modifications observées (liste vide = aucune) : id des lignes
// présentes avant ET après dont le contenu a changé.
export function modifiedRows(before: RowSnapshot, after: RowSnapshot): string[] {
  const changed: string[] = [];
  for (const table of WATCHED) {
    for (const [id, json] of before[table]) {
      const now = after[table].get(id);
      if (now !== undefined && now !== json) changed.push(`${table}:${id}`);
    }
  }
  return changed;
}

export function totalRows(snapshot: RowSnapshot): number {
  return WATCHED.reduce((sum, table) => sum + snapshot[table].size, 0);
}
