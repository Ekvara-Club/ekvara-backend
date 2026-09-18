import { WorldTaekwondoResultsImporterService, WtrBlockedError, WtrHttpError } from "./wt-results-importer.service";
import { ALICE, competitionListHtml, MATCH_1_ID, matchPageHtml, profilePageHtml, resultsListHtml } from "./wtr-test-fixtures";

function htmlResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, { status: init.status ?? 200, headers: { "content-type": "text/html", ...init.headers } });
}

function build(responses: Response[] | ((url: string) => Response), overrides: { minIntervalMs?: number; now?: () => number } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const sleeps: number[] = [];
  const queue = Array.isArray(responses) ? [...responses] : null;

  const fetchImpl = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return queue ? queue.shift()! : (responses as (url: string) => Response)(String(input));
  }) as unknown as typeof fetch;

  const service = new WorldTaekwondoResultsImporterService({
    fetchImpl,
    minIntervalMs: overrides.minIntervalMs ?? 2000,
    now: overrides.now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { service, calls, sleeps, fetchImpl: fetchImpl as unknown as jest.Mock };
}

describe("WorldTaekwondoResultsImporterService", () => {
  it("envoie un User-Agent honnête identifiant EKVARA (jamais un navigateur usurpé) et Accept: text/html", async () => {
    const { service, calls } = build([htmlResponse(matchPageHtml())]);
    await service.fetchMatch("exemple-2026", MATCH_1_ID);

    expect(calls[0].headers["User-Agent"]).toMatch(/^EkvaraBackend\/1\.0 \(\+https:\/\/ekvara\.fr/);
    expect(calls[0].headers["User-Agent"]).not.toMatch(/Mozilla|Chrome|Safari/i);
    expect(calls[0].headers.Accept).toBe("text/html");
  });

  it("le User-Agent est une valeur d'en-tête HTTP valide (ASCII imprimable) : accepté par le vrai constructeur Headers de fetch", async () => {
    const { service, calls } = build([htmlResponse(matchPageHtml())]);
    await service.fetchMatch("exemple-2026", MATCH_1_ID);

    const userAgent = calls[0].headers["User-Agent"];
    expect(userAgent).toMatch(/^[\x20-\x7e]+$/);
    // Le fetch réel lève TypeError sur un caractère > 255 (bug constaté lors du premier run réel).
    expect(() => new Headers({ "User-Agent": userAgent })).not.toThrow();
  });

  it("construit les bonnes URL (liste année, résultats + filtre catégorie, match, profil)", async () => {
    const { service, calls } = build(() => htmlResponse(competitionListHtml([])), { minIntervalMs: 0 });
    await service.fetchCompetitionList(2026);
    await service.fetchResultsListing("roma-2026-world-taekwondo-grand-prix");
    await service.fetchResultsListing("roma-2026-world-taekwondo-grand-prix", "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    await service.fetchMatch("roma-2026-world-taekwondo-grand-prix", MATCH_1_ID).catch(() => undefined);
    await service.fetchProfile(ALICE.id).catch(() => undefined);

    expect(calls.map((c) => c.url)).toEqual([
      "https://results.worldtaekwondo.org/competitions?year=2026",
      "https://results.worldtaekwondo.org/competitions/roma-2026-world-taekwondo-grand-prix/results",
      "https://results.worldtaekwondo.org/competitions/roma-2026-world-taekwondo-grand-prix/results?event=dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      `https://results.worldtaekwondo.org/competitions/roma-2026-world-taekwondo-grand-prix/results/${MATCH_1_ID}`,
      `https://results.worldtaekwondo.org/profile/${ALICE.id}`,
    ]);
  });

  it("aucune pause avant la 1ʳᵉ requête, puis attend l'intervalle minimal restant entre deux requêtes", async () => {
    let clock = 10_000;
    const { service, sleeps } = build(
      () => htmlResponse(resultsListHtml({ matchIds: [] })),
      { minIntervalMs: 2000, now: () => clock },
    );

    await service.fetchResultsListing("a");
    expect(sleeps).toEqual([]);

    clock += 500; // 500 ms écoulées : il reste 1500 ms à attendre
    await service.fetchResultsListing("b");
    expect(sleeps).toEqual([1500]);

    clock += 5000; // largement > intervalle : aucune attente
    await service.fetchResultsListing("c");
    expect(sleeps).toEqual([1500]);
  });

  it("compte les pages réellement récupérées", async () => {
    const { service } = build(() => htmlResponse(resultsListHtml({ matchIds: [] })), { minIntervalMs: 0 });
    await service.fetchResultsListing("a");
    await service.fetchResultsListing("b");
    expect(service.getPagesFetched()).toBe(2);
  });

  describe("protections : arrêt net, jamais de contournement ni de retry", () => {
    it.each([401, 403, 429, 503])("HTTP %i ⇒ WtrBlockedError, une seule requête (aucun retry)", async (status) => {
      const { service, fetchImpl } = build(() => htmlResponse("blocked", { status }));
      await expect(service.fetchMatch("x", MATCH_1_ID)).rejects.toBeInstanceOf(WtrBlockedError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("en-tête cf-mitigated ⇒ WtrBlockedError", async () => {
      const { service } = build([htmlResponse("challenge", { headers: { "cf-mitigated": "challenge" } })]);
      await expect(service.fetchProfile(ALICE.id)).rejects.toBeInstanceOf(WtrBlockedError);
    });

    it('page « Attention Required! | Cloudflare » servie avec un 200 ⇒ WtrBlockedError', async () => {
      const { service } = build([htmlResponse("<html><head><title>Attention Required! | Cloudflare</title></head></html>")]);
      await expect(service.fetchCompetitionList(2026)).rejects.toBeInstanceOf(WtrBlockedError);
    });

    it('page « Just a moment » servie avec un 200 ⇒ WtrBlockedError', async () => {
      const { service } = build([htmlResponse("<html><head><title>Just a moment...</title></head></html>")]);
      await expect(service.fetchCompetitionList(2026)).rejects.toBeInstanceOf(WtrBlockedError);
    });

    it("le message d'erreur mentionne explicitement l'absence de contournement", async () => {
      const { service } = build([htmlResponse("no", { status: 403 })]);
      await expect(service.fetchMatch("x", MATCH_1_ID)).rejects.toThrow(/aucun contournement/);
    });
  });

  it("404 ⇒ WtrHttpError (pas un blocage), sans retry", async () => {
    const { service, fetchImpl } = build([htmlResponse("nf", { status: 404 })]);
    const error = await service.fetchMatch("x", MATCH_1_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WtrHttpError);
    expect((error as WtrHttpError).status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("erreur réseau ⇒ WtrHttpError, sans retry", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    const service = new WorldTaekwondoResultsImporterService({ fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMs: 0 });
    await expect(service.fetchProfile(ALICE.id)).rejects.toBeInstanceOf(WtrHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("délègue le parsing : match et profil valides", async () => {
    const { service } = build([htmlResponse(matchPageHtml()), htmlResponse(profilePageHtml())], { minIntervalMs: 0 });
    const match = await service.fetchMatch("x", MATCH_1_ID);
    const profile = await service.fetchProfile(ALICE.id);
    expect(match.ok).toBe(true);
    expect(profile.ok && profile.profile.recordWins).toBe(53);
  });
});
