#!/usr/bin/env bash
# Synchro des sources (compétitions FFTDA / WT / Martial Events + résultats
# WT récents des athlètes). Lancée tous les 3 jours par cron :
#   crontab -e  ->  0 4 */3 * * /home/<user>/ekvara/backend/deploy/sync-sources.sh
# flock : jamais deux synchros en même temps (une synchro longue n'est pas
# doublée par la suivante). Journal : ~/ekvara/sync/sync.log
set -euo pipefail
cd "$(dirname "$0")/.."

LOG_DIR="${LOG_DIR:-$HOME/ekvara/sync}"
mkdir -p "$LOG_DIR"

exec 9>"$LOG_DIR/sync.lock"
if ! flock -n 9; then
  echo "[sync $(date -Iseconds)] synchro précédente encore en cours, ignorée" >> "$LOG_DIR/sync.log"
  exit 0
fi

npm run --silent sync:sources >> "$LOG_DIR/sync.log" 2>&1
