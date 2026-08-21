import {
  normalizeCategoryLabel,
  normalizeMartialEventsCompetition,
  parseMartialEventsEntriesFragment,
} from "./me-normalizer";

// Fixture dérivée de la structure RÉELLE observée sur
// https://www.martial.events/fr/events/championnat-de-france-seniors-combat-2026
// (microdonnées schema.org/Event, inspection HTML directe le 21/08/2026).
// Champs volontairement raccourcis à ce qui est réellement utilisé par le
// normaliseur — voir le rapport pour le HTML complet inspecté.
const EVENT_PAGE_FIXTURE = `
<div class="events event-single event-1229" itemscope itemtype="http://schema.org/Event">
  <h1 itemprop="name">Championnat de France Seniors (Combat)</h1>
  <meta itemprop="startDate" content="2026-02-21" />
  <meta itemprop="endDate" content="2026-02-21" />
</div>
<div itemprop="location" itemscope itemtype="http://schema.org/Place">
  <meta itemprop="address" content="CENTRE SPORTIF ATHLETICA, 64 rue des Bouquinvilles, 95600, Eaubonne, France" />
  <meta itemprop="name" content="CENTRE SPORTIF ATHLETICA" />
</div>
<div class="panel-body">
  <dl>
    <dt>Fédération Française de Taekwondo (FFTDA)</dt>
    <dd><a href="mailto:dtna@fftda.fr">dtna@fftda.fr</a></dd>
  </dl>
</div>
`;

// Un événement sur 2 jours (dateFin réellement différente de dateDebut), organisateur
// régional plutôt que fédéral — dérivé de
// https://www.martial.events/fr/events/selections-regionales-idf-combat-championnat-de-france-2026
const MULTI_DAY_EVENT_FIXTURE = `
<div class="events event-single event-1243" itemscope itemtype="http://schema.org/Event">
  <h1 itemprop="name">Sélections Régionales IDF Combat - Championnat de France</h1>
  <meta itemprop="startDate" content="2026-01-17" />
  <meta itemprop="endDate" content="2026-01-18" />
</div>
<div itemprop="location" itemscope itemtype="http://schema.org/Place">
  <meta itemprop="address" content="Stade Pierre de Coubertin, 82 avenue Georges Lafont, 75016, Paris, France" />
  <meta itemprop="name" content="Stade Pierre de Coubertin" />
</div>
<div class="panel-body">
  <dl>
    <dt>Ligue Île de France</dt>
    <dd><a href="mailto:contact@example.org">contact@example.org</a></dd>
  </dl>
</div>
`;

// Fragment /entries : structure réellement observée (table par catégorie avec
// <caption>, une ligne par inscrit). Noms fictifs (le fragment réel liste de vrais
// compétiteurs, non reproduits ici) mais mêmes propriétés structurelles réellement
// rencontrées : accents, noms composés/doubles tirets, ligue absente sur certaines
// lignes, statut "en attente paiement" imbriqué dans la cellule Nom, espacement HTML
// irrégulier.
const ENTRIES_FRAGMENT_FIXTURE = `
<div class="table-responsive">
  <table id="eg142211" class="table table-striped">
    <caption>Seniors Masculins -74 kg <span class="pull-right">3 inscriptions3 inscrits</span></caption>
    <thead><tr><th>No.</th><th>Nom</th><th>Équipe</th><th>Pays</th></tr></thead>
    <tbody>
      <tr class="">
        <td>1</td>
        <td>Noé LAMBERT-DUBOIS<br/></td>
        <td>TKD Club Exemple
          <div class="text-italic text-muted text-size-mini">Ligue Île de France</div>
        </td>
        <td>
          <i class="flag-icon flag-icon-fr"></i>
          <span>France</span>
        </td>
      </tr>
      <tr class="text-warning">
        <td>2</td>
        <td>Andréa MÉNARD--LEFÈVRE<br/>
          <div class="text-size-mini text-warning text-italic"><i class="icon-cash"></i> En attente paiement</div>
        </td>
        <td>Club Sans Ligue Renseignée</td>
        <td>
          <i class="flag-icon flag-icon-fr"></i>
          <span>France</span>
        </td>
      </tr>
      <tr class="">
        <td>3</td>
        <td>   Jean-Baptiste   N'GUYEN   <br/>   </td>
        <td>
          Autre Club
          <div class="text-italic text-muted text-size-mini">Ligue Occitanie</div>
        </td>
        <td>
          <i class="flag-icon flag-icon-fr"></i>
          <span>France</span>
        </td>
      </tr>
    </tbody>
  </table>
</div>
<div class="table-responsive">
  <table id="eg142220" class="table table-striped">
    <caption>Seniors Féminines -46 kg <span class="pull-right">1 inscription1 inscrite</span></caption>
    <thead><tr><th>No.</th><th>Nom</th><th>Équipe</th><th>Pays</th></tr></thead>
    <tbody>
      <tr class="">
        <td>1</td>
        <td>Camille ROUSSEAU<br/></td>
        <td>Club Féminin
          <div class="text-italic text-muted text-size-mini">Ligue Auvergne-Rhône-Alpes</div>
        </td>
        <td>
          <i class="flag-icon flag-icon-fr"></i>
          <span>France</span>
        </td>
      </tr>
    </tbody>
  </table>
</div>
<div class="table-responsive">
  <table id="eg142230" class="table table-striped">
    <caption>Seniors Masculins +87 kg <span class="pull-right">0 inscription0 inscrit</span></caption>
    <thead><tr><th>No.</th><th>Nom</th><th>Équipe</th><th>Pays</th></tr></thead>
    <tbody></tbody>
  </table>
</div>
`;

describe("normalizeMartialEventsCompetition", () => {
  it("extrait le nom, l'id externe stable et les dates depuis les microdonnées schema.org", () => {
    const result = normalizeMartialEventsCompetition(EVENT_PAGE_FIXTURE);
    expect(result?.source).toBe("martial_events");
    expect(result?.sourceExternalId).toBe("1229");
    expect(result?.nom).toBe("Championnat de France Seniors (Combat)");
    expect(result?.dateDebut).toEqual(new Date(Date.UTC(2026, 1, 21)));
  });

  it("ne pose pas dateFin quand startDate === endDate (événement sur un seul jour)", () => {
    const result = normalizeMartialEventsCompetition(EVENT_PAGE_FIXTURE);
    expect(result?.dateFin).toBeUndefined();
  });

  it("pose dateFin quand elle diffère réellement de dateDebut (événement multi-jours)", () => {
    const result = normalizeMartialEventsCompetition(MULTI_DAY_EVENT_FIXTURE);
    expect(result?.dateDebut).toEqual(new Date(Date.UTC(2026, 0, 17)));
    expect(result?.dateFin).toEqual(new Date(Date.UTC(2026, 0, 18)));
  });

  it("extrait ville et pays comme les deux derniers segments de l'adresse complète", () => {
    const result = normalizeMartialEventsCompetition(EVENT_PAGE_FIXTURE);
    expect(result?.ville).toBe("Eaubonne");
    expect(result?.pays).toBe("France");
  });

  it("extrait l'organisateur fédéral depuis le premier <dt>", () => {
    const result = normalizeMartialEventsCompetition(EVENT_PAGE_FIXTURE);
    expect(result?.organisateur).toBe("Fédération Française de Taekwondo (FFTDA)");
  });

  it("extrait un organisateur régional différent sur un autre événement (pas de mapping codé en dur)", () => {
    const result = normalizeMartialEventsCompetition(MULTI_DAY_EVENT_FIXTURE);
    expect(result?.organisateur).toBe("Ligue Île de France");
  });

  it("n'invente jamais de niveau (aucun champ structuré explicite sur la source)", () => {
    const result = normalizeMartialEventsCompetition(EVENT_PAGE_FIXTURE);
    expect(result?.niveau).toBeUndefined();
  });

  it("retourne null si les microdonnées schema.org/Event sont absentes", () => {
    const result = normalizeMartialEventsCompetition("<html><body>Page inattendue</body></html>");
    expect(result).toBeNull();
  });

  it("retourne null si l'id externe stable ne peut pas être extrait", () => {
    const html = EVENT_PAGE_FIXTURE.replace("event-single event-1229", "event-single");
    expect(normalizeMartialEventsCompetition(html)).toBeNull();
  });
});

describe("parseMartialEventsEntriesFragment — catégories et inscrits", () => {
  it("détecte chaque catégorie via sa table à <caption>, y compris une catégorie vide", () => {
    const categories = parseMartialEventsEntriesFragment(ENTRIES_FRAGMENT_FIXTURE);
    expect(categories).toHaveLength(3);
    expect(categories.map((c) => c.category.rawLabel)).toEqual([
      "Seniors Masculins -74 kg",
      "Seniors Féminines -46 kg",
      "Seniors Masculins +87 kg",
    ]);
  });

  it("ne compte jamais sur le compteur affiché dans le <caption>, seulement les lignes réelles", () => {
    const categories = parseMartialEventsEntriesFragment(ENTRIES_FRAGMENT_FIXTURE);
    expect(categories[0].entries).toHaveLength(3);
    expect(categories[1].entries).toHaveLength(1);
  });

  it("retourne un tableau d'inscrits vide pour une catégorie sans aucune ligne", () => {
    const categories = parseMartialEventsEntriesFragment(ENTRIES_FRAGMENT_FIXTURE);
    expect(categories[2].entries).toEqual([]);
  });

  it("extrait nom/club/ligue/pays pour un inscrit complet", () => {
    const categories = parseMartialEventsEntriesFragment(ENTRIES_FRAGMENT_FIXTURE);
    const entry = categories[0].entries[0];
    expect(entry).toEqual({
      name: "Noé LAMBERT-DUBOIS",
      club: "TKD Club Exemple",
      league: "Ligue Île de France",
      country: "France",
    });
  });

  it("retire le statut imbriqué (ex. 'En attente paiement') du nom sans le confondre avec le nom", () => {
    const categories = parseMartialEventsEntriesFragment(ENTRIES_FRAGMENT_FIXTURE);
    const entry = categories[0].entries[1];
    expect(entry.name).toBe("Andréa MÉNARD--LEFÈVRE");
  });

  it("renvoie league=null quand l'inscrit n'a pas de ligue renseignée (cas réel observé)", () => {
    const categories = parseMartialEventsEntriesFragment(ENTRIES_FRAGMENT_FIXTURE);
    const entry = categories[0].entries[1];
    expect(entry.club).toBe("Club Sans Ligue Renseignée");
    expect(entry.league).toBeNull();
  });

  it("normalise un espacement HTML irrégulier (retours à la ligne, espaces multiples)", () => {
    const categories = parseMartialEventsEntriesFragment(ENTRIES_FRAGMENT_FIXTURE);
    const entry = categories[0].entries[2];
    expect(entry.name).toBe("Jean-Baptiste N'GUYEN");
  });

  it("conserve les accents français dans les noms", () => {
    const categories = parseMartialEventsEntriesFragment(ENTRIES_FRAGMENT_FIXTURE);
    expect(categories[1].entries[0].name).toBe("Camille ROUSSEAU");
    expect(categories[1].entries[0].league).toBe("Ligue Auvergne-Rhône-Alpes");
  });

  it("ignore une ligne structurellement incomplète (moins de 3 colonnes) plutôt que de deviner", () => {
    const html = `
      <table><caption>Catégorie test</caption>
        <tbody><tr><td>1</td><td>Nom Seul</td></tr></tbody>
      </table>`;
    const categories = parseMartialEventsEntriesFragment(html);
    expect(categories[0].entries).toEqual([]);
  });

  it("retourne un tableau vide si aucune table à <caption> n'est présente", () => {
    expect(parseMartialEventsEntriesFragment("<div>Aucune catégorie</div>")).toEqual([]);
  });

  it("supporte plusieurs inscrits dans une même catégorie sans les mélanger entre catégories", () => {
    const categories = parseMartialEventsEntriesFragment(ENTRIES_FRAGMENT_FIXTURE);
    expect(categories[0].entries.map((e) => e.name)).not.toContain("Camille ROUSSEAU");
  });
});

describe("normalizeCategoryLabel", () => {
  it("sépare âge/genre/poids pour un libellé senior masculin standard", () => {
    const result = normalizeCategoryLabel("Seniors Masculins -74 kg");
    expect(result).toEqual({
      rawLabel: "Seniors Masculins -74 kg",
      ageCategory: "Senior",
      gender: "male",
      weightCategory: "-74 kg",
    });
  });

  it("sépare âge/genre/poids pour un libellé senior féminin", () => {
    const result = normalizeCategoryLabel("Seniors Féminines -46 kg");
    expect(result.ageCategory).toBe("Senior");
    expect(result.gender).toBe("female");
    expect(result.weightCategory).toBe("-46 kg");
  });

  it("supporte une catégorie de poids positive (+XX kg, catégorie la plus lourde)", () => {
    const result = normalizeCategoryLabel("Seniors Masculins +87 kg");
    expect(result.weightCategory).toBe("+87 kg");
  });

  it("reconnaît Cadets/Juniors quand présents dans le libellé (autres catégories d'âge FFTDA)", () => {
    expect(normalizeCategoryLabel("Cadets Masculins -55 kg").ageCategory).toBe("Cadet");
    expect(normalizeCategoryLabel("Juniors Féminines -52 kg").ageCategory).toBe("Junior");
  });

  it("conserve toujours rawLabel tel quel, même quand rien d'autre n'est interprétable", () => {
    const result = normalizeCategoryLabel("Catégorie Spéciale Poomsae Équipes");
    expect(result.rawLabel).toBe("Catégorie Spéciale Poomsae Équipes");
    expect(result.ageCategory).toBeNull();
    expect(result.gender).toBeNull();
    expect(result.weightCategory).toBeNull();
  });

  it("ne fabrique pas de catégorie de poids pour un libellé sans poids (ex. discipline Poomsae)", () => {
    const result = normalizeCategoryLabel("Seniors Masculins Poomsae");
    expect(result.ageCategory).toBe("Senior");
    expect(result.gender).toBe("male");
    expect(result.weightCategory).toBeNull();
  });

  it("ne devine jamais le genre quand il n'est pas explicitement mentionné", () => {
    const result = normalizeCategoryLabel("Seniors -74 kg");
    expect(result.gender).toBeNull();
  });

  // Libellés réels observés le 21/08/2026 sur le Championnat de France
  // Cadet-Junior 2026 (event-1302, 40 catégories réelles, 767 inscrits) —
  // confirme que le normalizer gère ces catégories réelles SANS modification.
  it("gère le libellé réel 'Cadets Féminines -44 kg' (Championnat de France Cadet-Junior 2026)", () => {
    const result = normalizeCategoryLabel("Cadets Féminines -44 kg");
    expect(result).toEqual({
      rawLabel: "Cadets Féminines -44 kg",
      ageCategory: "Cadet",
      gender: "female",
      weightCategory: "-44 kg",
    });
  });

  it("gère le libellé réel sans espace '+65kg' (variante de formatage observée réellement)", () => {
    const result = normalizeCategoryLabel("Juniors Masculins +65kg");
    expect(result.ageCategory).toBe("Junior");
    expect(result.gender).toBe("male");
    expect(result.weightCategory).toBe("+65 kg");
  });

  // Libellé réel observé le 21/08/2026 sur Poomsae Lab 2026 France
  // (event-1325, 1 seule catégorie plate "Poomsae Camp", 50 inscrits) : pas
  // de poids, pas de genre, structure fondamentalement différente du combat.
  // Le ticket demande explicitement de ne PAS construire de modèle Poomsae
  // ici — seule la dégradation propre vers rawLabel-only est attendue.
  it("dégrade proprement un libellé Poomsae réel sans structure combat ('Poomsae Camp')", () => {
    const result = normalizeCategoryLabel("Poomsae Camp");
    expect(result).toEqual({
      rawLabel: "Poomsae Camp",
      ageCategory: null,
      gender: null,
      weightCategory: null,
    });
  });

  // Limite connue et documentée (non un bug) : "Cadettes" (forme féminine
  // française fusionnée) n'a JAMAIS été observée sur Martial Events — la
  // forme réelle rencontrée est toujours "Cadets Féminines" (mot d'âge
  // invariant + mot de genre séparé, voir test ci-dessus). Le dictionnaire
  // n'a donc volontairement PAS été étendu pour la reconnaître : l'ajouter
  // sans l'avoir observée reviendrait à deviner. Ce test documente le
  // comportement actuel (dégradation sûre vers null) plutôt que de le cacher.
  it("documente la non-reconnaissance de 'Cadettes' (forme jamais observée réellement, non ajoutée par prudence)", () => {
    const result = normalizeCategoryLabel("Cadettes -44 kg");
    expect(result.ageCategory).toBeNull();
    expect(result.weightCategory).toBe("-44 kg");
  });
});
