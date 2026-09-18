import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import {
  competitionResultsUrl,
  matchUrl,
  parseCompetitionList,
  parseMatchPage,
  parseProfilePage,
  parseResultsListing,
  profileUrl,
  WT_RESULTS_BASE_URL,
  WtrCompetitionListItem,
  WtrMatchParseResult,
  WtrProfileParseResult,
  WtrResultsListing,
} from "./wtr-parser";

// Client HTTP + parsing de World Taekwondo Results. DISTINCT de
// WtImporterService (calendrier www.worldtaekwondo.org) : deux systèmes
// externes différents, deux jeux d'identifiants. Ne parle jamais à la DB.
//
// Règles de politesse (ticket "WT Results Data Foundation V1") :
//   - séquentiel, jamais de parallélisme : une seule requête à la fois, avec un
//     intervalle minimal entre deux requêtes (minIntervalMs) ;
//   - AUCUN retry : une requête échouée est rapportée, pas rejouée ;
//   - AUCUN contournement : User-Agent honnête et fixe (jamais modifié pour
//     franchir une protection) ; au premier signal de blocage (Cloudflare/WAF,
//     403, 429, 503) l'import s'arrête net (WtrBlockedError) ;
//   - pas de cookie/session conservé entre requêtes.

export const WTR_FETCH_OPTIONS = "WTR_FETCH_OPTIONS";

const DEFAULT_MIN_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 20_000;
// ASCII uniquement : un caractère hors Latin-1 (ex. tiret cadratin) est refusé par fetch() dans un en-tête.
const USER_AGENT = "EkvaraBackend/1.0 (+https://ekvara.fr; import World Taekwondo Results, limited POC)";

export interface WtrFetchOptions {
  minIntervalMs: number;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export class WtrBlockedError extends Error {}
export class WtrHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const BLOCK_STATUSES = new Set([401, 403, 429, 503]);

@Injectable()
export class WorldTaekwondoResultsImporterService {
  private readonly logger = new Logger(WorldTaekwondoResultsImporterService.name);
  private readonly options: WtrFetchOptions;
  private lastRequestAt = 0;
  private pagesFetched = 0;

  constructor(@Optional() @Inject(WTR_FETCH_OPTIONS) options?: Partial<WtrFetchOptions>) {
    this.options = {
      minIntervalMs: options?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchImpl: options?.fetchImpl ?? fetch,
      sleep: options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: options?.now ?? Date.now,
    };
  }

  getPagesFetched(): number {
    return this.pagesFetched;
  }

  async fetchCompetitionList(year: number): Promise<WtrCompetitionListItem[]> {
    const html = await this.getText(`${WT_RESULTS_BASE_URL}/competitions?year=${year}`);
    return parseCompetitionList(html);
  }

  async fetchResultsListing(slug: string, eventId?: string): Promise<WtrResultsListing> {
    const url = `${competitionResultsUrl(slug)}${eventId ? `?event=${encodeURIComponent(eventId)}` : ""}`;
    return parseResultsListing(await this.getText(url));
  }

  async fetchMatch(slug: string, matchId: string): Promise<WtrMatchParseResult> {
    return parseMatchPage(await this.getText(matchUrl(slug, matchId)), matchId);
  }

  async fetchProfile(athleteId: string): Promise<WtrProfileParseResult> {
    return parseProfilePage(await this.getText(profileUrl(athleteId)), athleteId);
  }

  private async getText(url: string): Promise<string> {
    const wait = this.lastRequestAt + this.options.minIntervalMs - this.options.now();
    if (this.lastRequestAt > 0 && wait > 0) {
      await this.options.sleep(wait);
    }
    this.lastRequestAt = this.options.now();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

    let response: Response;
    try {
      response = await this.options.fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        signal: controller.signal,
      });
    } catch (error) {
      throw new WtrHttpError(`requête impossible (${url}): ${(error as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }

    this.pagesFetched++;

    if (BLOCK_STATUSES.has(response.status) || response.headers.get("cf-mitigated")) {
      throw new WtrBlockedError(
        `accès refusé ou limité par la source (HTTP ${response.status}) sur ${url} — import interrompu, aucun contournement tenté`,
      );
    }
    if (!response.ok) {
      throw new WtrHttpError(`statut HTTP ${response.status} (${url})`, response.status);
    }

    const body = await response.text();
    if (/Attention Required! \| Cloudflare|<title>\s*Just a moment/i.test(body)) {
      throw new WtrBlockedError(`page de protection anti-bot détectée sur ${url} — import interrompu, aucun contournement tenté`);
    }
    return body;
  }
}
