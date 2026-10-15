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
