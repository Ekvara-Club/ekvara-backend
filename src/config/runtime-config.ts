// Configuration lue au démarrage (main.ts), isolée ici pour être testable
// sans lancer Nest. En développement, aucune variable n'est nécessaire : les
// valeurs par défaut correspondent aux deux frontends Vite locaux.

export const DEV_CORS_ORIGINS = ["http://localhost:5173", "http://localhost:5174"];

// CORS_ORIGINS = liste séparée par des virgules des origines autorisées
// (ex. "https://app.ekvara.fr,https://coach.ekvara.fr"). Obligatoire en
// production : jamais un repli silencieux sur localhost, qui bloquerait
// tous les vrais utilisateurs sans message clair.
export function resolveCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.CORS_ORIGINS?.trim();
  if (!raw) {
    if (env.NODE_ENV === "production") {
      throw new Error("CORS_ORIGINS est obligatoire en production (origines des frontends, séparées par des virgules)");
    }
    return DEV_CORS_ORIGINS;
  }
  const origins = raw
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter((origin) => origin.length > 0);
  for (const origin of origins) {
    if (!/^https?:\/\/[^/\s]+$/.test(origin)) {
      throw new Error(`Origine CORS invalide : "${origin}" (attendu : https://hote, sans chemin)`);
    }
  }
  return origins;
}

// TRUST_PROXY : valeur passée à Express "trust proxy" quand l'API tourne
// derrière un reverse proxy (Caddy + Cloudflare Tunnel sur le Pi). Sans elle,
// req.ip est l'adresse du proxy pour TOUS les utilisateurs et le throttling
// de /auth (login, register) les bloquerait ensemble. "loopback" = faire
// confiance aux proxys locaux uniquement. Absent = pas de proxy (dev).
export function resolveTrustProxy(env: NodeJS.ProcessEnv = process.env): string | number | boolean | undefined {
  const raw = env.TRUST_PROXY?.trim();
  if (!raw) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}
