import { createHash, randomInt } from "node:crypto";

// Alphabet volontairement privé des caractères ambigus (0/O, 1/I) : le code
// doit pouvoir être retranscrit à l'oral ou à la main sans erreur. 32
// caractères (2^5) x 8 caractères aléatoires = 32^8 = 2^40 combinaisons
// possibles (~1.1 x 10^12) : suffisant pour résister à un bruteforce en ligne
// même en l'absence de throttling, et défendu en plus par ThrottlerGuard sur
// POST /auth/invitations/validate (voir AuthController).
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_PREFIX = "EKV-";

// crypto.randomInt (jamais Math.random) : générateur cryptographiquement
// sûr, cohérent avec le reste du projet (argon2 pour les mots de passe).
export function generateInvitationCode(): string {
  let body = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    body += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `${CODE_PREFIX}${body}`;
}

// Normalisation déterministe AVANT hash : accepte indifféremment
// "ekv-k7m4p2q8", "EKV-K7M4P2Q8", "EKVK7M4P2Q8" ou "K7M4P2Q8" (préfixe
// optionnel), espaces superflus ignorés. Le résultat n'est jamais réaffiché à
// l'utilisateur, uniquement utilisé pour le hash/lookup (voir
// hashInvitationCode) — generateInvitationCode() reste la seule source du
// format d'affichage "EKV-XXXXXXXX".
export function normalizeInvitationCode(rawCode: string): string {
  return rawCode
    .trim()
    .toUpperCase()
    .replace(/^EKV-?/, "")
    .replace(/[^A-Z0-9]/g, "");
}

// SHA-256 est un choix délibérément différent d'argon2 (mots de passe) : le
// code est déjà généré avec une entropie cryptographique élevée (2^40),
// jamais choisi par un humain — un hash rapide est correct ici, et
// nécessaire pour un lookup unique par code_hash en O(1) (voir
// InvitationsRepository.findByCodeHash). Le code brut n'est jamais persisté.
export function hashInvitationCode(normalizedCode: string): string {
  return createHash("sha256").update(normalizedCode).digest("hex");
}
