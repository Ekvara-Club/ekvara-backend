import { WtrBlockedError, WtrHttpError } from "../wt-results/wt-results-importer.service";

// Classification PURE (aucun I/O) des erreurs de connexion PostgreSQL
// transitoires rencontrées par le moteur #12E sur un run de plusieurs heures
// (déconnexion réseau, timeout socket, redémarrage serveur, pool saturé).
//
// Seules ces erreurs déclenchent une reprise automatique avec backoff borné.
// Tout le reste (erreur métier, violation de contrainte, erreur HTTP WT,
// anti-bot) garde le comportement fail-closed existant. Les erreurs HTTP WT
// sont toujours wrappées en WtrHttpError/WtrBlockedError par l'importer :
// un ETIMEDOUT réseau côté WT ne peut donc jamais être pris pour une
// déconnexion DB.

// Codes Prisma « connexion » (P1001 injoignable, P1002 timeout, P1008 socket
// timeout, P1017 connexion fermée, P2024 timeout d'acquisition du pool).
const TRANSIENT_PRISMA_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);
// Erreurs socket Node (pg brut — connexion dédiée au lock).
const TRANSIENT_SOCKET_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNABORTED",
]);
// SQLSTATE PostgreSQL : classe 08 (connection exception) + arrêt/redémarrage serveur.
const TRANSIENT_SQLSTATE = /^(08\d{3}|57P01|57P02|57P03)$/;
// Kinds DriverAdapterError (@prisma/adapter-pg).
const TRANSIENT_ADAPTER_KINDS = new Set(["DatabaseNotReachable", "ConnectionClosed", "SocketTimeout", "TooManyConnections"]);
// Messages pg sans code exploitable.
const TRANSIENT_MESSAGE =
  /Connection terminated|connection timeout|Client has encountered a connection error|Can't reach database server|Server has closed the connection|Operation has timed out/i;

export function isTransientDbError(error: unknown): boolean {
  if (error instanceof WtrHttpError || error instanceof WtrBlockedError) return false;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const e = current as { code?: unknown; errorCode?: unknown; kind?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === "string" && (TRANSIENT_PRISMA_CODES.has(e.code) || TRANSIENT_SOCKET_CODES.has(e.code) || TRANSIENT_SQLSTATE.test(e.code))) {
      return true;
    }
    if (typeof e.errorCode === "string" && TRANSIENT_PRISMA_CODES.has(e.errorCode)) return true;
    if (typeof e.kind === "string" && TRANSIENT_ADAPTER_KINDS.has(e.kind)) return true;
    if (typeof e.message === "string" && TRANSIENT_MESSAGE.test(e.message)) return true;
    current = e.cause;
  }
  return false;
}

export interface BackoffPolicy {
  maxAttempts: number; // nombre de tentatives de reprise consécutives sans progrès
  baseDelayMs: number;
  maxDelayMs: number;
}

// ~5 min cumulées au pire (2+4+8+16+32+60+60+60+60 s) avant d'abandonner :
// couvre un redémarrage/failover serveur sans boucler indéfiniment.
export const DEFAULT_DB_RETRY_POLICY: BackoffPolicy = { maxAttempts: 9, baseDelayMs: 2_000, maxDelayMs: 60_000 };

// Backoff exponentiel borné, sans jitter (un seul processus par run, sous lock).
export function backoffDelayMs(attempt: number, policy: BackoffPolicy): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Message d'erreur sans jamais exposer l'URL de connexion (secrets).
export function describeDbError(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown } | null;
  const code = e && typeof e.code === "string" ? `[${e.code}] ` : "";
  const message = e && typeof e.message === "string" ? e.message : String(error);
  return `${code}${message.replace(/postgres(ql)?:\/\/[^\s"']+/gi, "postgresql://***")}`.slice(0, 300);
}
