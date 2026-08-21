import * as cheerio from "cheerio";

// Découverte des prochaines compétitions Martial Events (voir ticket "étendre
// Martial Events aux prochaines compétitions"). Fonctions pures de parsing —
// aucun accès réseau ici (voir me-importer.service.ts pour la pagination).
//
// La page /fr/events affiche deux blocs distincts partageant la MÊME structure
// de tableau ("Plus d'événements à venir" et "Plus d'événements passés") :
// jamais parser toute la page sans scoper explicitement à la section
// "événements à venir" (`section.events-upcoming`), sous peine de mélanger des
// événements déjà passés dans la découverte.

export interface MartialEventsDiscoveredEvent {
  slug: string;
  name: string;
  // Code ISO 3166-1 alpha-2 en minuscule (ex. "fr"), extrait de la classe CSS
  // `flag-icon-XX` — plus fiable que le texte libre du pays (jamais de
  // dépendance à l'orthographe/la langue d'affichage du nom de pays).
  countryCode: string | null;
}

export function parseMartialEventsUpcomingListingPage(html: string): MartialEventsDiscoveredEvent[] {
  const $ = cheerio.load(html);
  const results: MartialEventsDiscoveredEvent[] = [];
  const seenSlugs = new Set<string>();

  function addCandidate(slug: string | null, name: string, countryCode: string | null) {
    if (!slug || !name || seenSlugs.has(slug)) return;
    seenSlugs.add(slug);
    results.push({ slug, name, countryCode });
  }

  const $upcoming = $("section.events-upcoming");

  // 1) Cartes "mises en avant" en tête de page : microdonnées schema.org/Event
  // fiables, mais ne montrent que les tout prochains événements (redondant
  // avec le tableau ci-dessous, jamais la seule source).
  $upcoming.find('[itemtype="http://schema.org/Event"]').each((_, el) => {
    const $el = $(el);
    const url = $el.find('meta[itemprop="url"]').first().attr("content");
    const name = normalizeWhitespace($el.find('[itemprop="name"]').first().text());
    const countryCode = extractCountryCode($el.find(".flag-icon").first().attr("class"));
    addCandidate(extractSlug(url), name, countryCode);
  });

  // 2) Tableau paginé "Plus d'événements à venir" : pas de microdonnées, mais
  // seule source donnant la liste complète (au-delà des tout prochains).
  $upcoming.find("table tr").each((_, rowEl) => {
    const $row = $(rowEl);
    const $link = $row.find('a[href^="/fr/events/"]').first();
    if ($link.length === 0) return;
    const name = normalizeWhitespace($link.text());
    const countryCode = extractCountryCode($row.find(".flag-icon").first().attr("class"));
    addCandidate(extractSlug($link.attr("href")), name, countryCode);
  });

  return results;
}

// --- Filtrage "France + probablement taekwondo" -----------------------------
//
// IMPORTANT : Martial Events n'expose AUCUN champ structuré "sport" ou
// "discipline", ni sur la page de listing ni sur la page événement (vérifié
// par inspection directe des deux). Le filtrage ne peut donc PAS reposer sur
// un champ fiable à 100 % — il repose sur deux signaux documentés :
//
// 1. `countryCode === "fr"` : signal structurel fiable (classe CSS
//    `flag-icon-fr`, jamais du texte libre).
// 2. Une hypothèse documentée, non garantie par la donnée elle-même :
//    l'instance `www.martial.events` utilisée (liée explicitement depuis la
//    page officielle fftda.fr/fr/16-reglements-inscriptions.html) est dédiée
//    au taekwondo. Confirmé empiriquement le 21/08/2026 : sur 41 noms
//    d'événements à venir inspectés, 41/41 sont sans ambiguïté liés au
//    taekwondo (Kyorugi, Poomsae, ou noms déjà identifiés comme tels dans un
//    ticket précédent, ex. "Open de Bordeaux Métropole"). Cette hypothèse
//    n'est PAS vérifiable structurellement et devra être revalidée
//    périodiquement si le catalogue s'élargit.
//
// Conséquence pratique : on EXCLUT plutôt qu'on n'INCLUT positivement — un nom
// mentionnant explicitement un autre art martial, ou un type d'événement non
// compétitif connu (stage, camp, séminaire...), est écarté. Tout le reste,
// en France, est retenu. Une inclusion positive par mot-clé "taekwondo"
// exclurait à tort des événements réels comme "Open de Bordeaux Métropole".
const NON_COMPETITION_KEYWORDS = [
  "camp",
  "stage",
  "séminaire",
  "seminaire",
  "training",
  "formation",
  "clinic",
  "workshop",
];

const OTHER_MARTIAL_ART_KEYWORDS = [
  "judo",
  "karate",
  "karaté",
  "krav maga",
  "kravmaga",
  "jiu-jitsu",
  "jiujitsu",
  "mma",
  "kickbox",
  "aikido",
  "boxe",
  "boxing",
];

export function isLikelyFrenchTaekwondoCompetition(event: MartialEventsDiscoveredEvent): boolean {
  if (event.countryCode !== "fr") {
    return false;
  }

  const lower = event.name.toLowerCase();
  if (NON_COMPETITION_KEYWORDS.some((kw) => lower.includes(kw))) {
    return false;
  }
  if (OTHER_MARTIAL_ART_KEYWORDS.some((kw) => lower.includes(kw))) {
    return false;
  }

  return true;
}

function extractSlug(hrefOrUrl: string | undefined): string | null {
  if (!hrefOrUrl) return null;
  const match = hrefOrUrl.match(/\/fr\/events\/([^/?#]+)/);
  return match ? match[1] : null;
}

function extractCountryCode(classAttr: string | undefined): string | null {
  const match = (classAttr ?? "").match(/\bflag-icon-([a-z]{2})\b/);
  return match ? match[1] : null;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
