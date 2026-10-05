// Rapprochement de NOMS uniquement pour SUGGÉRER un profil World Taekwondo à
// l'athlète (jamais pour relier automatiquement : voir athlete_wt_link).
// Insensible à la casse, aux accents et à l'ordre prénom/nom ("Kaïs Dilmi"
// ≈ "DILMI Kais"), séparateurs (tiret, apostrophe) traités comme des espaces.

export function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function nameTokens(value: string): string[] {
  return stripAccents(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

// Tous les mots du nom de l'athlète EKVARA doivent apparaître dans le nom
// WT (qui peut en compter davantage : deuxième prénom, nom composé).
export function namesMatch(ekvaraFullName: string, wtDisplayName: string): boolean {
  const wanted = nameTokens(ekvaraFullName);
  if (wanted.length < 2) return false;
  const available = new Set(nameTokens(wtDisplayName));
  return wanted.every((token) => available.has(token));
}
