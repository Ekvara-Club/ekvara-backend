# Migration `20261016150000_add_admin_session_and_login_attempt` — procédure Vercel

Portail EkvaraAdmin : sessions administrateur révocables (`admin_session`) et limitation des
connexions partagée entre instances (`admin_login_attempt`).

**Statut** : appliquée uniquement à la base de test isolée `ekvara_test`. **Jamais appliquée à la
production** ; son application en production exige une autorisation explicite.

## Contenu

| Objet | Effet |
|---|---|
| `CREATE TABLE admin_session` | `id` (UUID, clé), `app_user_id` (FK `app_user`, `ON DELETE CASCADE`), `created_at`, `expires_at`, `revoked_at` (timestamptz) |
| `CREATE TABLE admin_login_attempt` | `key` (empreinte HMAC `ip:` / `account:`, clé), `window_start` (timestamptz), `hits` |
| 3 index | `admin_session(app_user_id)`, `admin_session(expires_at)`, `admin_login_attempt(window_start)` |
| 1 clé étrangère | `admin_session.app_user_id` → `app_user.id` |

Migration **additive** : aucune table ni colonne existante n'est modifiée. Le code actuellement en
production ignore ces tables ; les sessions Athlete/Coach (JWT sans état) ne sont pas concernées.
Aucune IP ni adresse e-mail n'est stockée en clair.

## Ordre imposé sur Vercel

Le build Vercel exécute `prisma generate && nest build`, **pas** `prisma migrate deploy`. Le nouveau
code lit et écrit ces tables dès la première connexion admin : la migration doit donc être appliquée
**avant** le déploiement du code, et rien ne l'applique automatiquement.

1. **Sauvegarde** de la base de production (outil de l'hébergeur PostgreSQL, ou `pg_dump` vers un
   fichier local chiffré).
2. **Contrôle préalable (lecture seule)** depuis un poste de confiance, avec l'URL de production
   fournie à la commande et jamais écrite dans un fichier versionné :

   ```bash
   DATABASE_URL="<url de production>" npx prisma migrate status
   ```

   Attendu : seule `20261016150000_add_admin_session_and_login_attempt` est en attente.
3. **Application** (après autorisation explicite) :

   ```bash
   DATABASE_URL="<url de production>" npx prisma migrate deploy
   ```

   Durée : instantanée (deux tables vides). Sans effet sur le code en production (tables ignorées).
4. **Vérification (lecture seule)** : `prisma migrate status` → « Database schema is up to date ».
5. **Ensuite seulement**, déploiement du code (fusion dans `main` → déploiement Vercel de production).

## Retour arrière

| Situation | Action |
|---|---|
| Problème avec le nouveau code | *Instant Rollback* Vercel vers le déploiement précédent. Les tables restent et sont ignorées : **aucune action sur la base**. |
| Retirer aussi le schéma (rarement utile) | Après le retour du code, et après sauvegarde : supprimer les deux tables puis la ligne de `_prisma_migrations` correspondante (voir ci-dessous). |
| Échec pendant `migrate deploy` | `prisma migrate status` indique l'état. Corriger puis relancer, ou `prisma migrate resolve --rolled-back 20261016150000_add_admin_session_and_login_attempt` après vérification que rien n'a été créé. |

SQL de suppression du schéma (à exécuter uniquement sur décision explicite, code précédent déjà en
place) :

```sql
BEGIN;
DROP TABLE "admin_login_attempt";
DROP TABLE "admin_session";
DELETE FROM "_prisma_migrations"
 WHERE migration_name = '20261016150000_add_admin_session_and_login_attempt';
COMMIT;
```

## Effets au déploiement du code

- Les jetons admin émis avant le déploiement (sans `sid`) sont refusés : l'administrateur se reconnecte
  une fois. Aucune session Athlete/Coach n'est affectée.
- Chaque requête admin lit sa session par clé primaire (une requête indexée).
- Sessions et compteurs expirés sont purgés à chaque connexion admin (aucune tâche planifiée).
- `TRUST_PROXY=true` est requis sur Vercel pour une limite par IP réelle (voir `.env.example`).

## Base de développement locale

Le client Prisma généré connaît désormais ces tables. Une base de développement locale qui ne les a pas
fera échouer la connexion admin : y appliquer `npx prisma migrate deploy` (avec l'URL de cette base),
sur décision de son propriétaire.
