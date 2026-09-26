import { normalizeWtEvent, parseWtCalendarPage, WtRawEvent } from "./wt-normalizer";

// Fixture représentative de la structure réelle du fragment WT :
// - td[0..3] = date / discipline / grade / PSS (répétés par sous-catégorie)
// - td[4..6] = titre / lieu / (colonne vide), portés uniquement par la ligne
//   "ancre" grâce à rowspan, partagés visuellement par les sous-catégories suivantes.
const WT_FRAGMENT_FIXTURE = `
<div class="tbl-calendar">
<table>
<thead><tr><th>Date</th><th>Discipline</th><th>Grade</th><th>PSS</th><th>Title</th><th>Location</th><th></th></tr></thead>
<tbody>
<tr>
  <td>February 1-2</td>
  <td>Kyorugi / Senior</td>
  <td>G-2</td>
  <td>KPNP</td>
  <td rowspan="3"><a href="javascript:;" class="tit-link f-underline listView" data-details-key="26032">13th Fujairah International Taekwondo Open Championships</a></td>
  <td rowspan="3">Fujairah, United Arab Emirates</td>
  <td rowspan="3"></td>
</tr>
<tr>
  <td>February 3</td>
  <td>Kyorugi / Junior</td>
  <td>N/A</td>
  <td>KPNP</td>
</tr>
<tr>
  <td>February 4</td>
  <td>Kyorugi / Cadet</td>
  <td>N/A</td>
  <td>KPNP</td>
</tr>
<tr>
  <td>March 6</td>
  <td>Poomsae</td>
  <td>G-1</td>
  <td>N/A</td>
  <td rowspan="1"><a href="javascript:;" class="tit-link f-underline listView" data-details-key="26999">Sample Single Day Open</a></td>
  <td rowspan="1">Vienna, Austria</td>
  <td rowspan="1"></td>
</tr>
<tr>
  <td>April 12 - 17</td>
  <td>Kyorugi</td>
  <td>G-1</td>
  <td>N/A</td>
  <td rowspan="1"><a href="javascript:;" class="tit-link f-underline listView" data-details-key="27000">Sample Multi Day Championships</a></td>
  <td rowspan="1">Roma, Italy</td>
  <td rowspan="1"></td>
</tr>
<tr>
  <td>Feburary 7</td>
  <td>Kyorugi</td>
  <td>G-1</td>
  <td>N/A</td>
  <td rowspan="1"><a href="javascript:;" class="tit-link f-underline listView" data-details-key="27001">Sample Invalid Date Open</a></td>
  <td rowspan="1">Innsbruck, Austria</td>
  <td rowspan="1"></td>
</tr>
</tbody>
</table>
</div>
`;

describe("parseWtCalendarPage", () => {
  it("détecte chaque événement une seule fois via son detailsKey", () => {
    const events = parseWtCalendarPage(WT_FRAGMENT_FIXTURE);
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.detailsKey)).toEqual(["26032", "26999", "27000", "27001"]);
  });

  it("extrait titre, ville et pays depuis la ligne ancre", () => {
    const events = parseWtCalendarPage(WT_FRAGMENT_FIXTURE);
    const single = events.find((e) => e.detailsKey === "26999");
    expect(single?.title).toBe("Sample Single Day Open");
    expect(single?.location).toBe("Vienna, Austria");
  });

  it("regroupe les sous-catégories Senior/Junior/Cadet d'un même événement (rowspan)", () => {
    const events = parseWtCalendarPage(WT_FRAGMENT_FIXTURE);
    const fujairah = events.find((e) => e.detailsKey === "26032");
    expect(fujairah?.dateTexts).toEqual(["February 1-2", "February 3", "February 4"]);
  });

  it("n'attribue pas les sous-catégories d'un événement à l'événement suivant", () => {
    const events = parseWtCalendarPage(WT_FRAGMENT_FIXTURE);
    const single = events.find((e) => e.detailsKey === "26999");
    expect(single?.dateTexts).toEqual(["March 6"]);
  });
});

describe("normalizeWtEvent", () => {
  const raw = (overrides: Partial<WtRawEvent>): WtRawEvent => ({
    detailsKey: "1",
    title: "Test Open",
    location: "Vienna, Austria",
    dateTexts: ["March 6"],
    ...overrides,
  });

  it("source vaut toujours 'world_taekwondo'", () => {
    const result = normalizeWtEvent(raw({}), 2026);
    expect(result?.source).toBe("world_taekwondo");
  });

  it("sourceExternalId est stable et dérivé du detailsKey", () => {
    const result = normalizeWtEvent(raw({ detailsKey: "26032" }), 2026);
    expect(result?.sourceExternalId).toBe("26032");
    const again = normalizeWtEvent(raw({ detailsKey: "26032" }), 2026);
    expect(again?.sourceExternalId).toBe(result?.sourceExternalId);
  });

  it("niveau vaut toujours 'international' pour cette première version", () => {
    const result = normalizeWtEvent(raw({}), 2026);
    expect(result?.niveau).toBe("international");
  });

  it("n'invente pas d'organisateur", () => {
    const result = normalizeWtEvent(raw({}), 2026);
    expect(result?.organisateur).toBeUndefined();
  });

  it("extrait ville et pays depuis 'Ville, Pays'", () => {
    const result = normalizeWtEvent(raw({ location: "Fujairah, United Arab Emirates" }), 2026);
    expect(result?.ville).toBe("Fujairah");
    expect(result?.pays).toBe("United Arab Emirates");
  });

  it("normalise un événement sur un seul jour sans dateFin", () => {
    const result = normalizeWtEvent(raw({ dateTexts: ["March 6"] }), 2026);
    expect(result?.dateDebut).toEqual(new Date(Date.UTC(2026, 2, 6)));
    expect(result?.dateFin).toBeUndefined();
  });

  it("normalise un événement sur plusieurs jours (format 'D-D')", () => {
    const result = normalizeWtEvent(raw({ dateTexts: ["February 1-2"] }), 2026);
    expect(result?.dateDebut).toEqual(new Date(Date.UTC(2026, 1, 1)));
    expect(result?.dateFin).toEqual(new Date(Date.UTC(2026, 1, 2)));
  });

  it("normalise un événement sur plusieurs jours (format 'D - D' avec espaces)", () => {
    const result = normalizeWtEvent(raw({ dateTexts: ["April 12 - 17"] }), 2026);
    expect(result?.dateDebut).toEqual(new Date(Date.UTC(2026, 3, 12)));
    expect(result?.dateFin).toEqual(new Date(Date.UTC(2026, 3, 17)));
  });

  it("supporte un changement de mois dans la plage de dates", () => {
    const result = normalizeWtEvent(raw({ dateTexts: ["April 30 - May 2"] }), 2026);
    expect(result?.dateDebut).toEqual(new Date(Date.UTC(2026, 3, 30)));
    expect(result?.dateFin).toEqual(new Date(Date.UTC(2026, 4, 2)));
  });

  it("calcule dateDebut/dateFin comme min/max sur un événement Senior/Junior/Cadet multi-dates", () => {
    const result = normalizeWtEvent(
      raw({ dateTexts: ["February 1-2", "February 3", "February 4"] }),
      2026,
    );
    expect(result?.dateDebut).toEqual(new Date(Date.UTC(2026, 1, 1)));
    expect(result?.dateFin).toEqual(new Date(Date.UTC(2026, 1, 4)));
  });

  it("rejette (retourne null) une date avec une faute de frappe plutôt que de la deviner ('Feburary')", () => {
    const result = normalizeWtEvent(raw({ dateTexts: ["Feburary 7"] }), 2026);
    expect(result).toBeNull();
  });

  it("rejette un jour hors plage pour le mois donné", () => {
    const result = normalizeWtEvent(raw({ dateTexts: ["February 30"] }), 2026);
    expect(result).toBeNull();
  });

  it("ignore une sous-date invalide isolée si au moins une autre date de l'événement est valide", () => {
    const result = normalizeWtEvent(raw({ dateTexts: ["Feburary 7", "February 8"] }), 2026);
    expect(result?.dateDebut).toEqual(new Date(Date.UTC(2026, 1, 8)));
    expect(result?.dateFin).toBeUndefined();
  });

  it("rejette l'événement si aucune date n'est interprétable", () => {
    const result = normalizeWtEvent(raw({ dateTexts: ["June 4 Virtual Taekwondo"] }), 2026);
    expect(result).toBeNull();
  });
});

// #22 : colonne Discipline conservée ligne par ligne (texte brut + dates dérivées).
describe("divisions du calendrier WT (#22)", () => {
  const raw = (overrides: Partial<WtRawEvent>): WtRawEvent => ({
    detailsKey: "1",
    title: "Test Open",
    location: "Vienna, Austria",
    dateTexts: ["March 6"],
    ...overrides,
  });

  it("capture Date et Discipline de chaque ligne (ancre puis sous-lignes), dans l'ordre de la page", () => {
    const fujairah = parseWtCalendarPage(WT_FRAGMENT_FIXTURE).find((e) => e.detailsKey === "26032");
    expect(fujairah?.rows).toEqual([
      { dateText: "February 1-2", discipline: "Kyorugi / Senior" },
      { dateText: "February 3", discipline: "Kyorugi / Junior" },
      { dateText: "February 4", discipline: "Kyorugi / Cadet" },
    ]);
  });

  it("n'attribue pas les lignes d'un événement à l'événement suivant", () => {
    const single = parseWtCalendarPage(WT_FRAGMENT_FIXTURE).find((e) => e.detailsKey === "26999");
    expect(single?.rows).toEqual([{ dateText: "March 6", discipline: "Poomsae" }]);
  });

  it("persiste les divisions avec dates dérivées par le même parseur que dateDebut/dateFin", () => {
    const [fujairah] = parseWtCalendarPage(WT_FRAGMENT_FIXTURE);
    const result = normalizeWtEvent(fujairah, 2026);
    expect(result?.divisions).toEqual([
      { dateText: "February 1-2", discipline: "Kyorugi / Senior", start: "2026-02-01", end: "2026-02-02" },
      { dateText: "February 3", discipline: "Kyorugi / Junior", start: "2026-02-03", end: "2026-02-03" },
      { dateText: "February 4", discipline: "Kyorugi / Cadet", start: "2026-02-04", end: "2026-02-04" },
    ]);
    // dates canoniques inchangées par la capture des divisions
    expect(result?.dateDebut).toEqual(new Date(Date.UTC(2026, 1, 1)));
    expect(result?.dateFin).toEqual(new Date(Date.UTC(2026, 1, 4)));
  });

  it("n'interprète jamais la discipline : une tranche d'âge seule (format 2025) reste telle quelle", () => {
    const result = normalizeWtEvent(
      raw({ dateTexts: ["June 6-7"], rows: [{ dateText: "June 6-7", discipline: "Senior" }] }),
      2025,
    );
    expect(result?.divisions).toEqual([{ dateText: "June 6-7", discipline: "Senior", start: "2025-06-06", end: "2025-06-07" }]);
  });

  it("garde une ligne à date illisible avec start/end null, sans la deviner", () => {
    const result = normalizeWtEvent(
      raw({
        dateTexts: ["June 4 Virtual Taekwondo", "June 5"],
        rows: [
          { dateText: "June 4 Virtual Taekwondo", discipline: "Kyorugi" },
          { dateText: "June 5", discipline: "" },
        ],
      }),
      2026,
    );
    expect(result?.divisions).toEqual([
      { dateText: "June 4 Virtual Taekwondo", discipline: "Kyorugi", start: null, end: null },
      { dateText: "June 5", discipline: null, start: "2026-06-05", end: "2026-06-05" },
    ]);
  });

  it("sans lignes source, n'émet aucune division (la colonne n'est alors jamais touchée)", () => {
    const result = normalizeWtEvent(raw({}), 2026);
    expect(result).not.toHaveProperty("divisions");
  });
});
