import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ImportedCompetition } from "../imported-competition.interface";
import {
  MartialEventsCategoryEntries,
  normalizeMartialEventsCompetition,
  parseMartialEventsEntriesFragment,
} from "./me-normalizer";
import {
  MartialEventsDiscoveredEvent,
  isLikelyFrenchTaekwondoCompetition,
  parseMartialEventsUpcomingListingPage,
} from "./me-discovery";

// Enregistré dans CompetitionsModule et utilisé par
// CompetitionsService.importMartialEvents() (voir ticket "Migration réelle
// vers competition canonique + competition_source") : discoverUpcomingEvents
// + fetchCompetition alimentent le pipeline d'upsert multi-source. Les
// entries (/entries) ne sont volontairement jamais appelées par ce chemin —
// aucun participant Martial Events n'est encore persisté (voir
// fetchCompetitionWithEntries, toujours réservée à l'exploration manuelle).
const BASE_URL = "https://www.martial.events";
const EVENTS_LIST_URL = `${BASE_URL}/fr/events`;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "EkvaraBackend/1.0 (+https://ekvara.fr; POC import Martial Events)";

// Garde-fou de politesse réseau : la pagination "à venir" observée
// réellement tient sur 2-3 pages ; 5 laisse une marge sans jamais permettre
// un crawl illimité. On s'arrête de toute façon dès qu'une page ne révèle
// plus aucun événement nouveau (voir discoverUpcomingEvents).
const MAX_LISTING_PAGES = 5;

export interface MartialEventsPocResult {
  competition: ImportedCompetition | null;
  categories: MartialEventsCategoryEntries[];
  totalEntries: number;
}

@Injectable()
export class MartialEventsImporterService {
  private readonly logger = new Logger(MartialEventsImporterService.name);

  // `slug` = segment d'URL tel qu'affiché sur martial.events, ex.
  // "championnat-de-france-seniors-combat-2026" pour
  // https://www.martial.events/fr/events/championnat-de-france-seniors-combat-2026
  async fetchCompetitionWithEntries(slug: string): Promise<MartialEventsPocResult> {
    const eventUrl = `${BASE_URL}/fr/events/${slug}`;
    const entriesUrl = `${eventUrl}/entries`;

    this.logger.log(`[POC] Récupération Martial.Events: ${eventUrl}`);
    const [eventHtml, entriesHtml] = await Promise.all([
      this.fetchHtml(eventUrl),
      this.fetchHtml(entriesUrl),
    ]);

    const competition = normalizeMartialEventsCompetition(eventHtml);
    const categories = parseMartialEventsEntriesFragment(entriesHtml);
    const totalEntries = categories.reduce((sum, c) => sum + c.entries.length, 0);

    this.logger.log(
      `[POC] ${categories.length} catégories détectées, ${totalEntries} inscrits au total`,
    );

    return { competition, categories, totalEntries };
  }

  // Récupère uniquement les métadonnées de compétition (pas les entries) —
  // utilisé par le pipeline d'import DB, où les entries ne sont pas
  // consommées : une requête réseau de moins par événement découvert que
  // fetchCompetitionWithEntries (politesse réseau, voir ticket précédent).
  async fetchCompetition(slug: string): Promise<ImportedCompetition | null> {
    const eventUrl = `${BASE_URL}/fr/events/${slug}`;
    this.logger.log(`[Import] Récupération Martial.Events: ${eventUrl}`);
    const eventHtml = await this.fetchHtml(eventUrl);
    return normalizeMartialEventsCompetition(eventHtml);
  }

  // Récupère uniquement les inscrits (/entries) — utilisé par la
  // synchronisation competition_entry, indépendamment de la récupération des
  // métadonnées de compétition (déjà upsertée à ce stade du pipeline). Lève
  // une ServiceUnavailableException (via fetchHtml) en cas d'échec HTTP —
  // c'est cette exception, jamais un contenu vide, qui distingue "échec de
  // récupération" de "compétition sans aucun inscrit pour l'instant" : un
  // tableau vide renvoyé ici est TOUJOURS une lecture réussie (0 inscrit
  // réel), jamais une erreur masquée.
  async fetchEntries(slug: string): Promise<MartialEventsCategoryEntries[]> {
    const entriesUrl = `${BASE_URL}/fr/events/${slug}/entries`;
    this.logger.log(`[Import] Récupération Martial.Events: ${entriesUrl}`);
    const entriesHtml = await this.fetchHtml(entriesUrl);
    return parseMartialEventsEntriesFragment(entriesHtml);
  }

  // Découvre les prochaines compétitions françaises de taekwondo listées sur
  // Martial Events, sans jamais coder en dur une liste de slugs (voir
  // ticket). Parcourt /fr/events (page 1, puis ?upcoming_page=2, 3...),
  // dédoublonne par slug (le site peut lui-même répéter un événement d'une
  // page à l'autre — constaté réellement), s'arrête dès qu'une page ne
  // révèle plus aucun événement nouveau, et filtre enfin sur
  // isLikelyFrenchTaekwondoCompetition.
  async discoverUpcomingEvents(): Promise<MartialEventsDiscoveredEvent[]> {
    const seenSlugs = new Set<string>();
    const all: MartialEventsDiscoveredEvent[] = [];

    for (let page = 1; page <= MAX_LISTING_PAGES; page++) {
      const url = page === 1 ? EVENTS_LIST_URL : `${EVENTS_LIST_URL}?upcoming_page=${page}`;
      this.logger.log(`[Découverte] Récupération Martial.Events: ${url}`);
      const html = await this.fetchHtml(url);
      const pageEvents = parseMartialEventsUpcomingListingPage(html);

      let newCount = 0;
      for (const event of pageEvents) {
        if (!seenSlugs.has(event.slug)) {
          seenSlugs.add(event.slug);
          all.push(event);
          newCount++;
        }
      }

      if (newCount === 0 && page > 1) {
        break;
      }
    }

    const relevant = all.filter(isLikelyFrenchTaekwondoCompetition);
    this.logger.log(
      `[Découverte] ${all.length} événements à venir vus, ${relevant.length} retenus (France + probable taekwondo)`,
    );
    return relevant;
  }

  private async fetchHtml(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`statut HTTP ${response.status}`);
      }

      return await response.text();
    } catch (error) {
      this.logger.error(`Échec de récupération Martial.Events (${url}): ${(error as Error).message}`);
      throw new ServiceUnavailableException("Martial.Events est actuellement indisponible");
    } finally {
      clearTimeout(timeout);
    }
  }
}
