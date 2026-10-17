# Mise en production EkvaraAdmin (backend Vercel) — dossier préparé, NON exécuté

Rien de ce document n'a été exécuté en production. Chaque étape marquée 🔒 exige une autorisation
explicite du propriétaire.

- Branche à livrer : `feature/admin-v1` (contient `github/main` = `c55b392`, dont `8d0ddc7`).
- Production : Vercel, branche de production `main`, `https://api.ekvara.fr`.
- Migration : `20261016150000_add_admin_session_and_login_attempt` (additive, voir
  `MIGRATION_ADMIN_SESSION.md`).

Règles pour toutes les commandes ci-dessous :

- l'URL de production n'est **jamais** écrite dans un fichier ni dans l'historique du shell ; elle est
  saisie avec `read -s` et effacée ensuite (`unset`) ;
- les commandes Prisma sont lancées depuis une copie propre de `feature/admin-v1` ;
  `prisma.config.ts` charge `.env` (base de **développement**) : la variable `DATABASE_URL` passée
  explicitement prend le dessus, et **chaque commande affiche la base ciblée** (ligne `Datasource`),
  à contrôler avant de continuer.

## 0. Vérifications Vercel avant tout push

| Vérification | Où | Attendu |
|---|---|---|
| Branche de production | Settings → Git → Production Branch | `main` |
| Déploiements d'aperçu automatiques | Settings → Git (intégration GitHub) et Settings → Build → *Ignored Build Step* | savoir si un push de `feature/admin-v1` crée un aperçu |
| Base utilisée par les aperçus | Settings → Environment Variables → `DATABASE_URL`, cible **Preview** | idéalement une base distincte de la production ; si c'est la production, un aperçu exécute le nouveau code sur la base de production (lecture des tables publiques ; endpoints admin fermés tant que `ADMIN_USER_IDS` n'existe pas en Preview, et en échec tant que la migration n'est pas appliquée) |
| `ADMIN_USER_IDS` | Environment Variables | **absente** des cibles Preview et Development |
| Protection des aperçus | Settings → Deployment Protection | activée (aperçus non publics) recommandée |

## 1. Sauvegarde PostgreSQL 🔒

Checklist :

- [ ] Identifier l'hébergeur de la base de production (variable `DATABASE_URL` de Vercel, cible Production).
- [ ] Si l'hébergeur propose une restauration à un instant donné (PITR) ou des sauvegardes gérées :
      noter l'heure exacte (UTC) juste avant la migration et vérifier que la fenêtre de rétention la couvre.
- [ ] En plus, sauvegarde logique `pg_dump` (format custom) sur un poste de confiance, fichier chiffré
      au repos, hors de tout dépôt Git.
- [ ] `pg_dump --version` ≥ version majeure du serveur (`SHOW server_version;`).
- [ ] Contrôle de la sauvegarde : `pg_restore --list` lisible, puis restauration d'essai dans une base
      locale jetable et comparaison de quelques comptages.

```bash
read -s -p "URL de production : " PROD_URL; echo
psql "$PROD_URL" -Atc "SHOW server_version;"          # lecture seule
pg_dump --version
pg_dump --format=custom --no-owner --dbname="$PROD_URL" \
  --file="ekvara-prod-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_restore --list ekvara-prod-*.dump | head            # le fichier est lisible

# Restauration d'essai dans une base LOCALE jetable
createdb ekvara_restore_check
pg_restore --no-owner --dbname=ekvara_restore_check ekvara-prod-*.dump
psql "$PROD_URL"              -Atc "select count(*) from competition; select count(*) from app_user;"
psql -d ekvara_restore_check  -Atc "select count(*) from competition; select count(*) from app_user;"
dropdb ekvara_restore_check
```

## 2. Contrôles préalables (lecture seule)

```bash
cd <copie propre de feature/admin-v1>
npm ci
DATABASE_URL="$PROD_URL" npx prisma migrate status
```

Attendu : `Datasource … at <hôte de production>`, et **une seule** migration en attente :
`20261016150000_add_admin_session_and_login_attempt`. Toute autre différence : **arrêter**.

```sql
-- lecture seule, via psql "$PROD_URL"
SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 3;
-- attendu : 20261006090000_add_user_consent en dernier, finished_at non NULL
SELECT to_regclass('public.admin_session'), to_regclass('public.admin_login_attempt');
-- attendu : deux NULL (tables absentes)
SELECT id, email FROM app_user WHERE lower(email) = lower('<email de l''administrateur>');
-- l'id (UUID) servira pour ADMIN_USER_IDS
```

## 3. Migration additive 🔒

```bash
DATABASE_URL="$PROD_URL" npx prisma migrate deploy
```

Attendu : « All migrations have been successfully applied ». Durée : instantanée (deux tables vides,
aucun verrou sur les tables existantes hormis la vérification de la clé étrangère vers `app_user`).
Le code en production ignore ces tables : aucun effet visible tant que le nouveau code n'est pas déployé.

## 4. Vérification après migration (lecture seule)

```bash
DATABASE_URL="$PROD_URL" npx prisma migrate status     # « Database schema is up to date! »
```

```sql
SELECT migration_name, finished_at, rolled_back_at
  FROM _prisma_migrations WHERE migration_name = '20261016150000_add_admin_session_and_login_attempt';
-- finished_at non NULL, rolled_back_at NULL

SELECT table_name, column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name IN ('admin_session', 'admin_login_attempt')
 ORDER BY table_name, ordinal_position;
-- admin_session : id uuid, app_user_id uuid, created_at/expires_at/revoked_at timestamptz
-- admin_login_attempt : key varchar, window_start timestamptz, hits integer

SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'admin_session'::regclass;
-- clé primaire + FK vers app_user(id) ON DELETE CASCADE
-- (PostgreSQL 18+ liste aussi les contraintes NOT NULL ; requêtes vérifiées sur ekvara_test)

SELECT (SELECT count(*) FROM admin_session) AS sessions, (SELECT count(*) FROM admin_login_attempt) AS tentatives;
-- 0 / 0

SELECT count(*) FROM app_user;   -- identique à la valeur relevée avant la migration
```

```bash
curl -s https://api.ekvara.fr/health      # {"status":"ok","database":"ok"} : production inchangée
unset PROD_URL
```

## 5. Configuration Vercel (Production) 🔒

| Variable | Valeur | Remarque |
|---|---|---|
| `ADMIN_USER_IDS` | UUID relevé à l'étape 2 | **Production uniquement** ; sans elle, aucun administrateur |
| `TRUST_PROXY` | `true` | Vercel réécrit `X-Forwarded-For` avec l'IP réelle du client |
| `JWT_SECRET`, `DATABASE_URL`, `NODE_ENV`, `CORS_ORIGINS` | inchangées | aucune origine localhost à ajouter |

Une variable ne prend effet qu'au déploiement suivant (ici, la fusion de l'étape 6).
Noter l'identifiant du **déploiement de production courant** (Deployments → Production) pour le retour arrière.

## 6. Déploiement 🔒

Fusion de la PR `feature/admin-v1` → `main` sur GitHub (sans *squash* ni *rebase*, pour conserver
`8d0ddc7` tel quel) → déploiement Vercel automatique.

## 7. Vérifications après déploiement

```bash
API=https://api.ekvara.fr
curl -s $API/health                                                   # {"status":"ok","database":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" $API/admin/auth/session       # 401 (et non plus 404)
curl -s -D - -o /dev/null $API/admin/auth/session | grep -i cache-control   # no-store
curl -s -D - -o /dev/null $API/competitions      | grep -i cache-control    # no-store (8d0ddc7 conservé)
curl -s -D - -o /dev/null $API/route-inconnue    | grep -i cache-control    # no-store
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H 'Content-Type: application/json' \
  -d '{}' $API/admin/competitions                                     # 401 (aucune écriture sans session)
curl -s -D - -o /dev/null -H "Origin: https://evil.example" $API/admin/auth/session \
  | grep -i access-control-allow-origin || echo "aucune origine étrangère autorisée"
```

Puis, depuis le portail local en mode production (`npm run dev:prod`, Chrome ou Firefox) :

- [ ] connexion admin, tableau de bord, navigation **en lecture** ;
- [ ] déconnexion, puis ancienne session refusée (rafraîchir : retour à `/login`) ;
- [ ] applications Athlete (`www.ekvara.fr`) et Coach (`coach.ekvara.fr`) : connexion et pages
      principales inchangées ;
- [ ] journaux Vercel : `admin.login.success` et `admin.logout` présents, aucune erreur ;
- [ ] première écriture = première vraie saisie (aucune donnée de test en production).

## 8. Retour arrière

| Situation | Action | Base |
|---|---|---|
| Régression après déploiement | Vercel → Deployments → déploiement noté à l'étape 5 → **Instant Rollback** (immédiat, sans build) | aucune action : les tables nouvelles sont ignorées par l'ancien code |
| Couper seulement le portail admin | supprimer `ADMIN_USER_IDS` (Production) puis redéployer | aucune action |
| La fusion dans `main` doit être annulée dans Git | PR de *revert* du commit de fusion sur GitHub (jamais de force-push sur `main`) | aucune action |
| Retirer aussi le schéma (rarement utile) | après retour du code et sauvegarde : procédure de `MIGRATION_ADMIN_SESSION.md` | 🔒 suppression des deux tables |
| Données endommagées (aucun scénario identifié) | restauration PITR ou `pg_restore` de la sauvegarde de l'étape 1 | 🔒 |
