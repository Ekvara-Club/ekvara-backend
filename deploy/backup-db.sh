#!/usr/bin/env bash
# Sauvegarde PostgreSQL (format custom, restaurable avec pg_restore), 14 jours
# conservés. Lancé chaque nuit par cron et avant chaque mise à jour.
#   crontab -e  ->  30 3 * * * /home/<user>/ekvara/backend/deploy/backup-db.sh >> /home/<user>/ekvara/backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-$HOME/ekvara/backups}"
mkdir -p "$BACKUP_DIR"

# DATABASE_URL lu depuis .env (sans exécuter le fichier).
DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
FILE="$BACKUP_DIR/ekvara-$(date +%Y%m%d-%H%M%S).dump"

pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file="$FILE"
echo "Sauvegarde : $FILE ($(du -h "$FILE" | cut -f1))"

find "$BACKUP_DIR" -name 'ekvara-*.dump' -mtime +14 -delete
