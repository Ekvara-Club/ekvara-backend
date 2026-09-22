import { Client } from "pg";

// Verrou anti double-run le plus simple approprié à l'existant : un advisory
// lock Postgres tenu sur UNE connexion dédiée pendant toute la durée du
// traitement (audit Phase 0 §Concurrency safety — pas de nouvelle table, pas
// de Redis/BullMQ). Volontairement PAS une requête brute via le pool Prisma :
// pg_advisory_lock/unlock sont liés à la SESSION physique, et le pool Prisma
// peut faire transiter deux requêtes successives par deux connexions
// différentes — une connexion dédiée est la seule façon correcte de garantir
// que "acquire" et "release" parlent à la même session.
export class RunLockBusyError extends Error {}

export async function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [runId]);
    if (!result.rows[0]?.locked) {
      throw new RunLockBusyError(`Run ${runId} déjà en cours de traitement par un autre processus (lock non acquis)`);
    }
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [runId]);
    }
  } finally {
    await client.end();
  }
}
