import { Prisma } from "../../generated/prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import { seedMetricTypes } from "../metrics/seed/seed-metric-types";

// Garde-fou des specs d'intégration du portail admin (ticket "EkvaraAdmin
// V1" : toute écriture de test sur une base ISOLÉE). Une spec qui écrit en
// base ne s'exécute que si DATABASE_URL désigne une base locale dont le nom
// contient "test" — jamais la base de dev, jamais une base distante. Les
// specs d'intégration historiques ne sont pas concernées (comportement
// inchangé). Usage : npm run test:testdb (charge .env.test).
export function isIsolatedTestDatabase(url: string | undefined = process.env.DATABASE_URL): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    const name = parsed.pathname.replace(/^\//, "");
    return local && /test/i.test(name);
  } catch {
    return false;
  }
}

// describe() sur base de test isolée, describe.skip() sinon (avec la raison
// visible dans le nom du bloc ignoré).
export function describeOnTestDatabase(name: string, fn: () => void): void {
  if (isIsolatedTestDatabase()) {
    describe(name, fn);
  } else {
    describe.skip(`${name} [ignoré : DATABASE_URL n'est pas une base de test locale isolée]`, fn);
  }
}

const MAX_SEED_ATTEMPTS = 3;

// Prérequis des specs qui lisent le catalogue de référence metric_type (voir
// docs/audit/TESTS_METRIC_TYPE_ORDER.md côté EkvaraAdmin) : rend chaque spec
// indépendante de l'ordre d'exécution de Jest.
// - Base de test isolée uniquement : sur une autre base (dev), aucune
//   écriture — le catalogue y est attendu (npm run seed:metrics),
//   comportement historique inchangé.
// - seedMetricTypes() est idempotent (crée les capacités manquantes, ne
//   modifie jamais une existante) mais pas atomique : deux specs lancées en
//   parallèle sur une base vide peuvent créer la même capacité au même
//   instant -> P2002 sur metric_type.code pour l'une d'elles. La capacité
//   existe alors : on relance le seed, qui la trouve.
export async function ensureMetricTypeCatalog(prisma: PrismaService): Promise<void> {
  if (!isIsolatedTestDatabase()) return;
  for (let attempt = 1; ; attempt++) {
    try {
      await seedMetricTypes(prisma);
      return;
    } catch (error) {
      const raced = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
      if (!raced || attempt >= MAX_SEED_ATTEMPTS) throw error;
    }
  }
}
