import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ImportedCompetition, ImportFetchResult } from "../imported-competition.interface";
import { normalizeWtEvent, parseWtCalendarPage } from "./wt-normalizer";

// Le calendrier WT (/calendar/event-calendar/list) est un squelette quasi vide
// piloté par un contrôleur JS maison qui charge son contenu via un fragment HTML
// (pas de JSON) sur cet endpoint. Un seul appel par année+discipline retourne déjà
// tous les événements de l'année (pas de pagination réelle observée).
const CALENDAR_PAGE_URL = "https://www.worldtaekwondo.org/calendar/event-calendar/page";
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "EkvaraBackend/1.0 (+https://ekvara.fr; import calendrier World Taekwondo)";

@Injectable()
export class WtImporterService {
  private readonly logger = new Logger(WtImporterService.name);

  async fetchCompetitions(year: number): Promise<ImportFetchResult> {
    this.logger.log(`Début import World Taekwondo (année ${year})`);

    const html = await this.fetchCalendarPage(year);
    const rawEvents = parseWtCalendarPage(html);
    this.logger.log(`Événements détectés: ${rawEvents.length}`);

    const competitions: ImportedCompetition[] = [];
    let failed = 0;

    for (const raw of rawEvents) {
      const normalized = normalizeWtEvent(raw, year);
      if (normalized) {
        competitions.push(normalized);
      } else {
        failed++;
        this.logger.warn(
          `Échec de normalisation pour l'événement WT #${raw.detailsKey} (${raw.title})`,
        );
      }
    }

    this.logger.log(`Import WT: ${competitions.length} normalisées, ${failed} rejetées`);

    return { detected: rawEvents.length, competitions, failed };
  }

  private async fetchCalendarPage(year: number): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const url = `${CALENDAR_PAGE_URL}?year=${year}&typeCd=TW`;
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`statut HTTP ${response.status}`);
      }

      return await response.text();
    } catch (error) {
      this.logger.error(
        `Échec de récupération du calendrier World Taekwondo: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException(
        "Le calendrier World Taekwondo est actuellement indisponible",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
