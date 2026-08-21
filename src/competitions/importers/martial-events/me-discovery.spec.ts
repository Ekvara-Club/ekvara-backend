import {
  isLikelyFrenchTaekwondoCompetition,
  parseMartialEventsUpcomingListingPage,
} from "./me-discovery";

// Fixtures calquées sur la structure HTML réelle de https://www.martial.events/fr/events
// (inspectée manuellement, voir rapport du ticket) : deux sections "à venir"
// (cartes en avant + tableau paginé) et une section "passés" partageant la
// même structure de tableau, qui ne doit JAMAIS être capturée par erreur.

const LISTING_PAGE_1 = `
<html><body>
  <div class="row">
    <div class="col-md-6">
      <section class="events-upcoming events-highlight-container">
        <ul class="media-list">
          <li class="media" itemscope itemtype="http://schema.org/Event">
            <meta itemprop="url" content="https://www.martial.events/fr/events/6th-online-taekangwon-open-poomsae-championships-2026" />
            <div class="media-body">
              <h4 class="media-heading" itemprop="name">6th Online TaeKangWon Open Poomsae Championships</h4>
            </div>
            <div class="media-right location" itemscope itemtype="http://schema.org/Place">
              <div class="flag-icon flag-icon-kr flag-icon-squared img-circle"></div>
            </div>
          </li>
        </ul>
      </section>
    </div>
    <div class="col-md-6">
      <section class="events-recent events-highlight-container">
        <p class="events-panel-empty">Aucun événement terminé dans les 9 derniers jours.</p>
      </section>
    </div>
  </div>
  <div class="row events-more">
    <div class="col-md-6">
      <section class="events-upcoming events-more-container events-upcoming-more" data-events-pane="upcoming">
        <table class="table events-archive-table">
          <thead>
            <tr><th>Dates</th><th>Événement</th><th>Addresse</th><th>Inscrits</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="col-date">2 sept. 2026<br/>5 sept. 2026</td>
              <td><a href="/fr/events/korea-ambassador-cup-uzbekistan-2026">Korea Ambassador Cup 2026</a></td>
              <td><div class="flag-icon flag-icon-uz flag-icon-squared"></div><small>Tashkent, </small><small>Uzbekistan</small></td>
              <td class="text-right">112</td>
            </tr>
            <tr>
              <td class="col-date">19 sept. 2026</td>
              <td><a href="/fr/events/open-de-bordeaux-metropole-2026">Open de Bordeaux Métropole</a></td>
              <td><div class="flag-icon flag-icon-fr flag-icon-squared"></div><small>Pessac, </small><small>France</small></td>
              <td class="text-right">28</td>
            </tr>
            <tr>
              <td class="col-date">28 oct. 2026<br/>31 oct. 2026</td>
              <td><a href="/fr/events/international-training-camp-poissy-2026">International Training Camp Poissy 2026</a></td>
              <td><div class="flag-icon flag-icon-fr flag-icon-squared"></div><small>Poissy, </small><small>France</small></td>
              <td class="text-right">0</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </div>
  <div class="row events-more">
    <div class="col-md-6">
      <section class="events-recent events-more-container events-past-more" data-events-pane="past">
        <table class="table events-archive-table">
          <thead>
            <tr><th>Dates</th><th>Événement</th><th>Addresse</th><th>Inscrits</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="col-date">10 août 2026</td>
              <td><a href="/fr/events/championnat-national-de-congo-2026">Championnat National de Congo</a></td>
              <td><div class="flag-icon flag-icon-cg flag-icon-squared"></div><small>Brazzaville, </small><small>Congo</small></td>
              <td class="text-right">64</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </div>
</body></html>
`;

const LISTING_PAGE_2_WITH_REPEAT = `
<html><body>
  <section class="events-upcoming events-more-container events-upcoming-more" data-events-pane="upcoming">
    <table>
      <tbody>
        <tr>
          <td class="col-date">19 sept. 2026</td>
          <td><a href="/fr/events/open-de-bordeaux-metropole-2026">Open de Bordeaux Métropole</a></td>
          <td><div class="flag-icon flag-icon-fr flag-icon-squared"></div><small>Pessac, </small><small>France</small></td>
          <td class="text-right">28</td>
        </tr>
        <tr>
          <td class="col-date">10 oct. 2026</td>
          <td><a href="/fr/events/9eme-open-intenational-de-villeneuve-sur-lot">9eme Open International de Villeneuve sur lot</a></td>
          <td><div class="flag-icon flag-icon-fr flag-icon-squared"></div><small>Villeneuve-sur-Lot, </small><small>France</small></td>
          <td class="text-right">13</td>
        </tr>
      </tbody>
    </table>
  </section>
</body></html>
`;

describe("parseMartialEventsUpcomingListingPage", () => {
  it("extrait les événements des cartes en avant ET du tableau paginé", () => {
    const events = parseMartialEventsUpcomingListingPage(LISTING_PAGE_1);
    const slugs = events.map((e) => e.slug);
    expect(slugs).toContain("6th-online-taekangwon-open-poomsae-championships-2026");
    expect(slugs).toContain("korea-ambassador-cup-uzbekistan-2026");
    expect(slugs).toContain("open-de-bordeaux-metropole-2026");
    expect(slugs).toContain("international-training-camp-poissy-2026");
  });

  it("ignore complètement la section des événements passés (pas de fuite)", () => {
    const events = parseMartialEventsUpcomingListingPage(LISTING_PAGE_1);
    const slugs = events.map((e) => e.slug);
    expect(slugs).not.toContain("championnat-national-de-congo-2026");
  });

  it("extrait le code pays depuis la classe flag-icon plutôt que le texte libre", () => {
    const events = parseMartialEventsUpcomingListingPage(LISTING_PAGE_1);
    const bordeaux = events.find((e) => e.slug === "open-de-bordeaux-metropole-2026");
    const korea = events.find((e) => e.slug === "6th-online-taekangwon-open-poomsae-championships-2026");
    expect(bordeaux?.countryCode).toBe("fr");
    expect(korea?.countryCode).toBe("kr");
  });

  it("ignore la ligne d'en-tête du tableau (pas de lien /fr/events/)", () => {
    const events = parseMartialEventsUpcomingListingPage(LISTING_PAGE_1);
    expect(events.some((e) => e.name === "Événement")).toBe(false);
  });

  it("dédoublonne par slug lorsqu'un même événement apparaît deux fois sur une même page (carte en avant + tableau)", () => {
    const duplicatedOnSamePage = `
      <html><body>
        <section class="events-upcoming events-highlight-container">
          <li itemscope itemtype="http://schema.org/Event">
            <meta itemprop="url" content="https://www.martial.events/fr/events/open-de-bordeaux-metropole-2026" />
            <h4 itemprop="name">Open de Bordeaux Métropole</h4>
            <div class="flag-icon flag-icon-fr"></div>
          </li>
        </section>
        <section class="events-upcoming events-more-container events-upcoming-more" data-events-pane="upcoming">
          <table><tbody>
            <tr>
              <td class="col-date">19 sept. 2026</td>
              <td><a href="/fr/events/open-de-bordeaux-metropole-2026">Open de Bordeaux Métropole</a></td>
              <td><div class="flag-icon flag-icon-fr flag-icon-squared"></div></td>
              <td class="text-right">28</td>
            </tr>
          </tbody></table>
        </section>
      </body></html>
    `;
    const events = parseMartialEventsUpcomingListingPage(duplicatedOnSamePage);
    const bordeauxOccurrences = events.filter((e) => e.slug === "open-de-bordeaux-metropole-2026");
    expect(bordeauxOccurrences.length).toBe(1);
  });

  it("permet de dédoublonner entre pages successives (le site répète parfois un événement d'une page à l'autre)", () => {
    const page1Events = parseMartialEventsUpcomingListingPage(LISTING_PAGE_1);
    const page2Events = parseMartialEventsUpcomingListingPage(LISTING_PAGE_2_WITH_REPEAT);
    const seen = new Set<string>();
    const merged = [...page1Events, ...page2Events].filter((e) => {
      if (seen.has(e.slug)) return false;
      seen.add(e.slug);
      return true;
    });
    const bordeauxOccurrences = merged.filter((e) => e.slug === "open-de-bordeaux-metropole-2026");
    expect(bordeauxOccurrences.length).toBe(1);
    expect(merged.map((e) => e.slug)).toContain("9eme-open-intenational-de-villeneuve-sur-lot");
  });
});

describe("isLikelyFrenchTaekwondoCompetition", () => {
  it("retient un événement français sans mot-clé d'exclusion", () => {
    expect(
      isLikelyFrenchTaekwondoCompetition({
        slug: "open-de-bordeaux-metropole-2026",
        name: "Open de Bordeaux Métropole",
        countryCode: "fr",
      }),
    ).toBe(true);
  });

  it("exclut un événement dont le pays n'est pas la France", () => {
    expect(
      isLikelyFrenchTaekwondoCompetition({
        slug: "korea-ambassador-cup-uzbekistan-2026",
        name: "Korea Ambassador Cup 2026",
        countryCode: "uz",
      }),
    ).toBe(false);
  });

  it("exclut un événement sans code pays connu", () => {
    expect(
      isLikelyFrenchTaekwondoCompetition({
        slug: "evenement-sans-pays",
        name: "Évènement sans pays",
        countryCode: null,
      }),
    ).toBe(false);
  });

  it("exclut un stage/camp français non compétitif (ex. réel : International Training Camp Poissy 2026)", () => {
    expect(
      isLikelyFrenchTaekwondoCompetition({
        slug: "international-training-camp-poissy-2026",
        name: "International Training Camp Poissy 2026",
        countryCode: "fr",
      }),
    ).toBe(false);
  });

  it("exclut un événement français mentionnant explicitement un autre art martial", () => {
    expect(
      isLikelyFrenchTaekwondoCompetition({
        slug: "open-de-judo-de-lyon-2026",
        name: "Open de Judo de Lyon",
        countryCode: "fr",
      }),
    ).toBe(false);
  });
});
