import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ImportedCompetition, ImportFetchResult } from "./imported-competition.interface";
import { FftdaCalendarResponse, isCompetition, normalizeFftdaItem } from "./fftda-normalizer";

// Le calendrier FFTDA (/fr/161-le-calendrier.html) est une SPA Vue qui charge
// ses événements depuis ce endpoint JSON (collection "Calendriers" = id 53).
// C'est la source de données réelle : pas de HTML à parser.
const CALENDAR_JSON_URL = "https://www.fftda.fr/files/collection/53/fr.json";
const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT = "EkvaraBackend/1.0 (+https://ekvara.fr; import calendrier FFTDA)";

@Injectable()
export class FftdaImporterService {
  private readonly logger = new Logger(FftdaImporterService.name);

  async fetchCompetitions(): Promise<ImportFetchResult> {
    this.logger.log("Début import FFTDA");

    const raw = await this.fetchCalendarJson();
    const candidates = raw.items.filter(isCompetition);
    this.logger.log(
      `Éléments détectés comme compétitions: ${candidates.length} / ${raw.items.length}`,
    );

    const competitions: ImportedCompetition[] = [];
    let failed = 0;

    for (const item of candidates) {
      const normalized = normalizeFftdaItem(item);
      if (normalized) {
        competitions.push(normalized);
      } else {
        failed++;
        this.logger.warn(
          `Échec de normalisation pour l'événement FFTDA #${item._id} (${item.name})`,
        );
      }
    }

    this.logger.log(`Import FFTDA: ${competitions.length} normalisées, ${failed} rejetées`);

    return { detected: candidates.length, competitions, failed };
  }

  private async fetchCalendarJson(): Promise<FftdaCalendarResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(CALENDAR_JSON_URL, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`statut HTTP ${response.status}`);
      }

      return (await response.json()) as FftdaCalendarResponse;
    } catch (error) {
      this.logger.error(`Échec de récupération du calendrier FFTDA: ${(error as Error).message}`);
      throw new ServiceUnavailableException("Le calendrier FFTDA est actuellement indisponible");
    } finally {
      clearTimeout(timeout);
    }
  }
}
