-- CreateTable
CREATE TABLE "competition_match_source" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "competition_match_id" UUID NOT NULL,
    "source" VARCHAR(50) NOT NULL,
    "source_external_id" VARCHAR(255) NOT NULL,
    "source_url" VARCHAR(500),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_match_source_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "competition_match_source_competition_match_id_idx" ON "competition_match_source"("competition_match_id");

-- CreateIndex
CREATE UNIQUE INDEX "competition_match_source_source_source_external_id_key" ON "competition_match_source"("source", "source_external_id");

-- AddForeignKey
ALTER TABLE "competition_match_source" ADD CONSTRAINT "competition_match_source_competition_match_id_fkey" FOREIGN KEY ("competition_match_id") REFERENCES "competition_match"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Données existantes (POC WT Results) : WT Results publie le même combat réel
-- sous plusieurs identifiants de match (Muju : 4 pages identiques par combat).
-- On conserve TOUS les identifiants comme provenance (competition_match_source)
-- et on ne garde qu'UN competition_match par combat logique.
--
-- Clé de rapprochement CONSERVATRICE (jamais une contrainte UNIQUE : un cas
-- conflictuel doit pouvoir rester stocké) :
--   (competition_id, category_label, contest_number, paire NON ORDONNÉE d'athlètes)
-- Un groupe n'est fusionné que si TOUTES ses lignes ont des attributs
-- strictement identiques : orientation A/B, scores, vainqueur, méthode, tour.
-- Sinon (CONFLICT) ou si category_label/contest_number sont NULL : aucune
-- fusion, les lignes sont conservées telles quelles.
--
-- Chaque étape est protégée : toute vérification qui échoue lève une exception
-- et annule TOUT le lot (rien n'est supprimé sans que sa provenance soit
-- rattachée et vérifiée).
-- ---------------------------------------------------------------------------

-- Garde-fou "aucune référence perdue" : seule la nouvelle table peut référencer
-- competition_match. Toute autre FK future/ignorée arrête la migration AVANT
-- toute suppression.
DO $$
DECLARE
  other_refs integer;
BEGIN
  SELECT count(*) INTO other_refs
    FROM pg_constraint
   WHERE contype = 'f'
     AND confrelid = 'competition_match'::regclass
     AND conrelid <> 'competition_match_source'::regclass;
  IF other_refs > 0 THEN
    RAISE EXCEPTION 'competition_match est référencée par % autre(s) clé(s) étrangère(s) : nettoyage annulé', other_refs;
  END IF;
END $$;

-- Plan : pour chaque ligne d'un groupe FUSIONNABLE, le competition_match conservé
-- (le plus ancien, puis id le plus petit — déterministe).
CREATE TEMP TABLE _cm_plan AS
WITH keyed AS (
  SELECT m.*,
         LEAST(m.athlete_a_id, m.athlete_b_id)    AS p1,
         GREATEST(m.athlete_a_id, m.athlete_b_id) AS p2
    FROM competition_match m
   WHERE m.category_label IS NOT NULL
     AND m.contest_number IS NOT NULL
),
grp AS (
  SELECT competition_id, category_label, contest_number, p1, p2,
         count(*) AS n,
         count(DISTINCT (athlete_a_id, score_a, score_b, winner_athlete_id, result_method, bracket_stage)) AS variants
    FROM keyed
   GROUP BY competition_id, category_label, contest_number, p1, p2
),
mergeable AS (
  SELECT * FROM grp WHERE n > 1 AND variants = 1
)
SELECT k.id, k.source, k.source_external_id,
       first_value(k.id) OVER (
         PARTITION BY g.competition_id, g.category_label, g.contest_number, g.p1, g.p2
         ORDER BY k.created_at, k.id
       ) AS keeper_id
  FROM keyed k
  JOIN mergeable g
    ON g.competition_id = k.competition_id
   AND g.category_label = k.category_label
   AND g.contest_number = k.contest_number
   AND g.p1 = k.p1
   AND g.p2 = k.p2;

CREATE TEMP TABLE _cm_counts AS
SELECT (SELECT count(*) FROM competition_match) AS matches_before,
       (SELECT count(*) FROM _cm_plan WHERE keeper_id <> id) AS to_delete;

-- Rattache les identifiants de TOUTES les représentations (194 sur le POC) au
-- competition_match conservé : la ligne elle-même si elle est conservée, le
-- « keeper » du groupe si elle est redondante.
INSERT INTO competition_match_source (competition_match_id, source, source_external_id, source_url, created_at)
SELECT COALESCE(p.keeper_id, m.id), m.source, m.source_external_id, m.source_url, m.created_at
  FROM competition_match m
  LEFT JOIN _cm_plan p ON p.id = m.id;

-- Vérifications AVANT suppression : une représentation source par ligne
-- existante, et chaque ligne redondante a bien son identifiant rattaché à son
-- competition_match conservé.
DO $$
DECLARE
  expected integer;
  actual integer;
  orphans integer;
BEGIN
  SELECT matches_before INTO expected FROM _cm_counts;
  SELECT count(*) INTO actual FROM competition_match_source;
  IF actual <> expected THEN
    RAISE EXCEPTION 'competition_match_source: % représentation(s) rattachée(s) pour % ligne(s) : nettoyage annulé', actual, expected;
  END IF;

  SELECT count(*) INTO orphans
    FROM _cm_plan p
   WHERE p.keeper_id <> p.id
     AND NOT EXISTS (
       SELECT 1 FROM competition_match_source s
        WHERE s.source = p.source
          AND s.source_external_id = p.source_external_id
          AND s.competition_match_id = p.keeper_id
     );
  IF orphans > 0 THEN
    RAISE EXCEPTION '% représentation(s) redondante(s) sans provenance rattachée : nettoyage annulé', orphans;
  END IF;
END $$;

-- Suppression des seules représentations redondantes (le keeper de chaque
-- groupe est conservé ; leurs identifiants source vivent déjà sous le keeper).
DELETE FROM competition_match m
 USING _cm_plan p
 WHERE p.id = m.id
   AND p.keeper_id <> m.id;

-- Vérifications APRÈS suppression.
DO $$
DECLARE
  expected_sources integer;
  expected_deleted integer;
  matches_after integer;
  sources_after integer;
  matches_without_source integer;
BEGIN
  SELECT matches_before, to_delete INTO expected_sources, expected_deleted FROM _cm_counts;
  SELECT count(*) INTO matches_after FROM competition_match;
  SELECT count(*) INTO sources_after FROM competition_match_source;
  SELECT count(*) INTO matches_without_source
    FROM competition_match m
   WHERE NOT EXISTS (SELECT 1 FROM competition_match_source s WHERE s.competition_match_id = m.id);

  IF sources_after <> expected_sources THEN
    RAISE EXCEPTION 'provenance perdue : % représentation(s) après nettoyage, % attendue(s)', sources_after, expected_sources;
  END IF;
  IF matches_after <> expected_sources - expected_deleted THEN
    RAISE EXCEPTION 'nombre de combats inattendu après nettoyage : %, attendu %', matches_after, expected_sources - expected_deleted;
  END IF;
  IF matches_without_source > 0 THEN
    RAISE EXCEPTION '% combat(s) sans aucune représentation source', matches_without_source;
  END IF;
END $$;

DROP TABLE _cm_plan;
DROP TABLE _cm_counts;
