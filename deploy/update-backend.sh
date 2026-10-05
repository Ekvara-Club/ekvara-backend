#!/usr/bin/env bash
# À lancer SUR LE PI, dans ~/ekvara/backend : met l'API à jour.
#   ./deploy/update-backend.sh
# Ordre volontaire : sauvegarde AVANT migration, et l'API n'est rechargée
# qu'une fois build + migrations réussis (set -e arrête tout sinon).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Sauvegarde de la base avant mise à jour"
./deploy/backup-db.sh

echo "== Récupération du code"
git pull --ff-only

echo "== Dépendances, client Prisma, build"
npm ci
npm run build

echo "== Migrations (additives uniquement, jamais de reset)"
npm run migrate:deploy

echo "== Redémarrage de l'API"
pm2 reload deploy/ecosystem.config.cjs --update-env

sleep 3
curl -fsS http://localhost:3000/health && echo && echo "OK : API à jour et base joignable."
