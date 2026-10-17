import { createHmac } from "node:crypto";

// Configuration de l'administration (ticket "EkvaraAdmin V1", décision D1),
// isolée ici pour être testable sans lancer Nest — même principe que
// config/runtime-config.ts.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ADMIN_USER_IDS = liste séparée par des virgules d'app_user.id autorisés à
// ouvrir une session d'administration. Absente ou vide : AUCUN administrateur
// (fermé par défaut, jamais un repli permissif). Une valeur mal formée fait
// échouer le démarrage plutôt que d'être ignorée silencieusement : un
// identifiant tronqué ne doit jamais donner l'illusion d'un accès configuré.
export function resolveAdminUserIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = env.ADMIN_USER_IDS?.trim();
  if (!raw) return new Set();
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  for (const id of ids) {
    if (!UUID_RE.test(id)) {
      throw new Error(`ADMIN_USER_IDS invalide : "${id}" n'est pas un identifiant app_user (UUID)`);
    }
  }
  return new Set(ids.map((id) => id.toLowerCase()));
}

// Secret de signature des sessions admin DÉRIVÉ de JWT_SECRET (aucun nouveau
// secret à gérer) mais distinct : un JWT athlète/coach ne vérifie jamais comme
// session admin, et un JWT admin ne vérifie jamais sur JwtAuthGuard.
export function deriveAdminJwtSecret(jwtSecret: string): string {
  return createHmac("sha256", jwtSecret).update("ekvara-admin-session-v1").digest("hex");
}

// Clé des empreintes de la limitation des connexions (admin_login_attempt) :
// également dérivée, distincte de la clé de signature.
export function deriveAdminThrottleSecret(jwtSecret: string): string {
  return createHmac("sha256", jwtSecret).update("ekvara-admin-throttle-v1").digest("hex");
}
