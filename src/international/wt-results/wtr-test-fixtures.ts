// Générateurs de HTML de test qui reproduisent la STRUCTURE réellement observée
// sur results.worldtaekwondo.org (classes CSS, ordre A puis B, attribut mal
// fermé `class="match-detail-value2 ""` inclus) avec des athlètes et des UUID
// SYNTHÉTIQUES : aucune donnée personnelle réelle n'est stockée dans le dépôt.

export interface FixtureAthlete {
  id: string;
  name: string;
  noc: string;
}

export const ALICE: FixtureAthlete = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Alice EXEMPLE", noc: "FRA" };
export const BRUNO: FixtureAthlete = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Bruno TESTEUR", noc: "KOR" };
export const CHLOE: FixtureAthlete = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Chloe SAMPLE", noc: "THA" };

export const MATCH_1_ID = "11111111-1111-4111-8111-111111111111";
export const MATCH_2_ID = "22222222-2222-4222-8222-222222222222";
export const MATCH_3_ID = "33333333-3333-4333-8333-333333333333";

export interface MatchFixtureOptions {
  competition?: string;
  contestNumber?: number | null;
  stage?: string | null;
  category?: string | null;
  a?: FixtureAthlete;
  b?: FixtureAthlete;
  scoreA?: string;
  scoreB?: string;
  winner?: "A" | "B" | "both" | null;
  methodText?: string;
  // Permet de simuler une page malformée / une orientation incohérente.
  linkAltA?: string;
  linkAltB?: string;
  omitParticipants?: boolean;
  profileLinkIds?: [string, string];
  // Variantes de photo réellement observées : "photo" (vraie photo + alt),
  // "placeholder" (athlète sans photo : placehold.co, SANS alt, texte "SURNAME
  // Given"), "photo-no-alt" (vraie photo sans alt), "none" (aucune image).
  photoA?: "photo" | "placeholder" | "photo-no-alt" | "none";
  photoB?: "photo" | "placeholder" | "photo-no-alt" | "none";
}

function photoImg(athlete: FixtureAthlete, id: string, mode: string, altOverride?: string): string {
  const alt = altOverride ?? athlete.name;
  if (mode === "placeholder") {
    const [given, ...rest] = athlete.name.split(" ");
    return `<img src="https://placehold.co/225x275?text=${rest.join(" ")} ${given}" class="photo" />`;
  }
  if (mode === "none") return "";
  const src = `https://results.worldtaekwondo.org/storage/photos/w225/${id}.jpg`;
  return mode === "photo-no-alt" ? `<img src="${src}" class="photo" />` : `<img src="${src}" class="photo" alt="${alt}" />`;
}

export function matchPageHtml(options: MatchFixtureOptions = {}): string {
  const {
    competition = "Exemple 2026 World Taekwondo Grand Prix",
    contestNumber = 140,
    stage = "F",
    category = "Women -49kg",
    a = ALICE,
    b = BRUNO,
    scoreA = "2",
    scoreB = "1",
    winner = "A",
    methodText = "Won by PTF",
    linkAltA,
    linkAltB,
    omitParticipants = false,
    profileLinkIds,
    photoA = "photo",
    photoB = "photo",
  } = options;

  const title =
    contestNumber === null && stage === null && category === null
      ? "Match"
      : `Contest Result ${contestNumber ?? ""} ${stage ? `(${stage})` : ""} / ${category ?? ""}`;

  const winnerA = winner === "A" || winner === "both" ? " winner" : "";
  const winnerB = winner === "B" || winner === "both" ? " winner" : "";
  const [idA, idB] = profileLinkIds ?? [a.id, b.id];
  // Comme sur le vrai site : le texte "Won by X" est dans la colonne du vainqueur.
  const methodCells =
    winner === "B"
      ? `<th></th><th></th><th>${methodText}</th>`
      : `<th>${methodText}</th><th></th><th></th>`;

  return `<!DOCTYPE html><html><body><main>
<h1 class=""><img src="https://results.worldtaekwondo.org/storage/logos/x.png" class="competition-logo" alt="${competition}" /><span>${competition}</span></h1>
<h2 class="mt-4 table-title">${title}</h2>
${
  omitParticipants
    ? ""
    : `<div class="row participants">
  <div class="col-6 text-left order-1">
    <h3>${a.name}</h3>
    <div class="mb-1 flag flag-left"><img src="/images/flags/${a.noc}.png" /><span>${a.noc}</span></div>
  </div>
  <div class="col-6 text-right order-2">
    <h3>${b.name}</h3>
    <div class="mb-1 flag flag-right"><span>${b.noc}</span><img src="/images/flags/${b.noc}.png" /></div>
  </div>
</div>`
}
<div class="row">
  <div class="col-6 col-sm-3 text-left order-1">
    <a href="https://results.worldtaekwondo.org/profile/${idA}" class="btn btn-profile">
      ${photoImg(a, idA, photoA, linkAltA)}
      <span>View profile</span>
    </a>
  </div>
  <div class="col-sm-6 order-3 order-sm-2">
    <table class="scores-rounds"><tbody></tbody></table>
    <table class="match-details">
      <tbody>
        <tr class="match-detail-round-score"><td class="round-winner">5</td><td class="round-label">R1</td><td class="">3</td></tr>
      </tbody>
      <tfoot>
        <tr class="match-detail-score final-score">
          <th class="match-detail-value1${winnerA}">${scoreA}</th>
          <th class="match-detail-label">Final Score</th>
          <th class="match-detail-value2${winnerB} "">${scoreB}</th>
        </tr>
        <tr class="match-detail-won">${methodCells}</tr>
      </tfoot>
    </table>
    <a href="https://results.worldtaekwondo.org/headtohead/${idA}/${idB}" class="btn btn-headtohead"><span>View all head to head contests</span></a>
  </div>
  <div class="col-6 col-sm-3 text-right order-2 order-sm-3">
    <a href="https://results.worldtaekwondo.org/profile/${idB}" class="btn btn-profile">
      ${photoImg(b, idB, photoB, linkAltB)}
      <span>View profile</span>
    </a>
  </div>
</div>
</main></body></html>`;
}

export function profilePageHtml(options: { athlete?: FixtureAthlete; record?: string | null; noc?: string | null } = {}): string {
  const { athlete = ALICE, record = "53 / 13 (80.3%)" } = options;
  const noc = options.noc === undefined ? athlete.noc : options.noc;
  const recordRow = record === null ? "" : `<dt class="col-md-9">Record (win / lose)</dt><dd class="col-md-3"> ${record} </dd>`;

  return `<!DOCTYPE html><html><body>
<nav><select id="contestant"><option>ZZZ Other Athlete</option></select></nav>
<div class="flex-center"><div class="content">
  <h1 class=""><span>Athlete Profile</span></h1>
  <div class="row"><div class="col-md-12">
    <h2>${athlete.name}</h2>
    <div class="mb-1 flag"><img src="/images/flags/${athlete.noc}.png" /><span>${noc ?? ""}</span></div>
  </div></div>
  <div class="row">
    <div class="col-md-3"><img src="https://results.worldtaekwondo.org/storage/photos/w225/${athlete.id}.jpg" alt="${athlete.name}" class="photo" /></div>
    <div class="col-md-9"><dl>${recordRow}<dt class="col-md-9">Record in 2026 (win / lose)</dt><dd class="col-md-3"> - </dd></dl></div>
  </div>
</div></div></body></html>`;
}

export function resultsListHtml(options: { matchIds: string[]; slug?: string; categories?: { label: string; id: string }[] }): string {
  const { matchIds, slug = "exemple-2026", categories = [{ label: "Men -68kg", id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }] } = options;
  const rows = matchIds
    .map(
      (id) => `<tr onclick="location.href='https://results.worldtaekwondo.org/competitions/${slug}/results/${id}'" class="rowlink "><td>F</td><td>Men -68kg</td><td class="flag home">FRA</td><td class="loser">A B</td><td class="score"> 0 : 2 </td><td>PTF</td><td class="winner">C D</td><td class="flag away">KOR</td><td class="link"> View </td></tr>`,
    )
    .join("\n");
  const opts = categories.map((c) => `<option value="${c.id}" >${c.label}</option>`).join("");
  return `<html><body><form id="results-filter" method="GET"><select id="weight" name="event"><option value="">- All weight categories -</option>${opts}</select></form><table>${rows}</table></body></html>`;
}

export interface CompetitionListFixtureRow {
  slug: string;
  name: string;
  dateText: string;
  withResults?: boolean;
}

export function competitionListHtml(rows: CompetitionListFixtureRow[]): string {
  const trs = rows
    .map(
      (r) => `<tr class=" grp-gp "><td class=""> ${r.dateText} </td><td class="competition-logo"><img src="x.png" alt="${r.name}"/></td><td><!-- <a href="https://results.worldtaekwondo.org/competitions/${r.slug}" class="btn btn-link">${r.name}</a> --> ${r.name} </td><td>${
        r.withResults === false
          ? ""
          : `<a href="https://results.worldtaekwondo.org/competitions/${r.slug}/results" class="btn btn-primary">Results</a>`
      }</td></tr>`,
    )
    .join("\n");
  return `<html><body><table>${trs}</table></body></html>`;
}
