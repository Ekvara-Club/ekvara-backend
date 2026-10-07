import { Client } from "pg";
import { backoffDelayMs, BackoffPolicy, describeDbError, isTransientDbError, sleep } from "./wt-backfill-db-errors";

// Verrou anti double-run le plus simple approprié à l'existant : un advisory
// lock Postgres tenu sur UNE connexion dédiée pendant toute la durée du
// traitement (audit Phase 0 §Concurrency safety — pas de nouvelle table, pas
// de Redis/BullMQ). Volontairement PAS une requête brute via le pool Prisma :
// pg_advisory_lock/unlock sont liés à la SESSION physique, et le pool Prisma
// peut faire transiter deux requêtes successives par deux connexions
// différentes — une connexion dédiée est la seule façon correcte de garantir
// que "acquire" et "release" parlent à la même session.
//
// Résilience (fix ETIMEDOUT) : cette connexion reste IDLE pendant des heures.
// Sans listener 'error', une coupure socket (ETIMEDOUT/ECONNRESET) émettait un
// 'error' non géré sur le Client pg => crash du process. Désormais :
//   - listener 'error' systématique (la perte est mémorisée, jamais fatale) ;
//   - keepAlive TCP pour limiter les coupures d'idle (NAT/proxy) ;
//   - ensureHeld() (appelé entre deux unités de travail) pingue la session et,
//     si elle est morte, rouvre une session et RÉACQUIERT le lock avec backoff
//     borné. Postgres relâche un advisory lock à la fin de sa session : tant
//     que le serveur n'a pas constaté la mort de l'ancienne session, le lock
//     peut sembler "occupé" — d'où plusieurs tentatives avant d'abandonner.
//   - Si le lock ne peut pas être réacquis : RunLockLostError, le service
//     s'arrête SANS écrire (un autre processus pourrait tenir le run).
export class RunLockBusyError extends Error {}
export class RunLockLostError extends Error {}

// Sous-ensemble de pg.Client utilisé ici (injectable pour les tests).
export interface LockClient {
  connect(): Promise<unknown>;
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  end(): Promise<void>;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export interface RunLock {
  // Garantit que le lock est (toujours) détenu par ce processus ; réacquiert
  // si la session a été perdue. Lève RunLockLostError si impossible.
  ensureHeld(): Promise<void>;
}

export interface RunLockOptions {
  createClient?: () => LockClient;
  reacquirePolicy?: BackoffPolicy;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

// ~4 min cumulées (1+2+4+8+16+30×6 s) : laisse au serveur le temps de
// constater la mort de l'ancienne session TCP (et donc de relâcher le lock).
export const DEFAULT_LOCK_REACQUIRE_POLICY: BackoffPolicy = { maxAttempts: 12, baseDelayMs: 1_000, maxDelayMs: 30_000 };

const LOCK_SQL = "SELECT pg_try_advisory_lock(hashtext($1)) AS locked";
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext($1))";

function defaultClient(): LockClient {
  return new Client({
    connectionString: process.env.DATABASE_URL,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  }) as unknown as LockClient;
}

async function safeEnd(client: LockClient): Promise<void> {
  try {
    await client.end();
  } catch {
    // Session déjà morte : rien à fermer, le serveur a (ou va) relâcher le lock.
  }
}

class PgRunLock implements RunLock {
  private client: LockClient | null = null;
  private lostError: Error | null = null;

  constructor(
    private readonly runId: string,
    private readonly options: Required<RunLockOptions>,
  ) {}

  // Ouvre une session et tente le lock. true = détenu ; false = occupé.
  private async openSession(): Promise<boolean> {
    const client = this.options.createClient();
    // Listener AVANT connect : c'est son absence qui provoquait le crash.
    client.on("error", (err) => {
      if (this.client === client && !this.lostError) {
        this.lostError = err;
        this.options.log(`[wt-backfill] connexion du lock perdue (${describeDbError(err)}) — réacquisition au prochain point de contrôle.`);
      }
    });
    try {
      await client.connect();
      const result = await client.query<{ locked: boolean }>(LOCK_SQL, [this.runId]);
      if (!result.rows[0]?.locked) {
        await safeEnd(client);
        return false;
      }
    } catch (error) {
      await safeEnd(client);
      throw error;
    }
    this.client = client;
    this.lostError = null;
    return true;
  }

  async acquire(): Promise<void> {
    if (!(await this.openSession())) {
      throw new RunLockBusyError(`Run ${this.runId} déjà en cours de traitement par un autre processus (lock non acquis)`);
    }
  }

  async ensureHeld(): Promise<void> {
    if (this.client && !this.lostError) {
      try {
        await this.client.query("SELECT 1");
        return;
      } catch (error) {
        if (!isTransientDbError(error)) throw error;
        this.lostError = error as Error;
      }
    }

    const dead = this.client;
    this.client = null;
    if (dead) await safeEnd(dead);

    const policy = this.options.reacquirePolicy;
    for (let attempt = 1; ; attempt++) {
      let reason: string;
      try {
        if (await this.openSession()) {
          this.options.log(`[wt-backfill] lock du run ${this.runId} réacquis (tentative ${attempt}).`);
          return;
        }
        reason = "lock détenu par une autre session";
      } catch (error) {
        if (!isTransientDbError(error)) throw error;
        reason = describeDbError(error);
      }
      if (attempt >= policy.maxAttempts) {
        throw new RunLockLostError(
          `Run ${this.runId} : lock perdu et non réacquis après ${attempt} tentative(s) (${reason}) — arrêt sans écriture.`,
        );
      }
      const delay = backoffDelayMs(attempt, policy);
      this.options.log(`[wt-backfill] réacquisition du lock impossible (${reason}) — nouvel essai dans ${delay} ms.`);
      await this.options.sleep(delay);
    }
  }

  async release(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    if (!this.lostError) {
      try {
        await client.query(UNLOCK_SQL, [this.runId]);
      } catch {
        // Session morte entre-temps : le serveur relâche le lock avec elle.
      }
    }
    await safeEnd(client);
  }
}

export async function withRunLock<T>(runId: string, fn: (lock: RunLock) => Promise<T>, options: RunLockOptions = {}): Promise<T> {
  const lock = new PgRunLock(runId, {
    createClient: options.createClient ?? defaultClient,
    reacquirePolicy: options.reacquirePolicy ?? DEFAULT_LOCK_REACQUIRE_POLICY,
    sleep: options.sleep ?? sleep,
    log: options.log ?? ((message) => console.error(message)),
  });
  await lock.acquire();
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}
