#!/usr/bin/env bash
# À lancer SUR TON MAC : build des deux frontends pour la production et copie
# sur le Pi (fichiers statiques servis par Caddy).
#   EKVARA_DOMAIN=ekvara.fr PI=pi@raspberrypi.local ./deploy/publish-frontends.sh
# Les tests sont lancés avant : rien n'est publié s'ils échouent (jusqu'à
# 2 relances par test, pour qu'un test instable connu ne bloque pas une mise
# en ligne ; un vrai échec reste bloquant).
set -euo pipefail
: "${EKVARA_DOMAIN:?EKVARA_DOMAIN requis (ex. ekvara.fr)}"
: "${PI:?PI requis (ex. pi@raspberrypi.local)}"

# Dossier qui contient EkvaraBackend, EkvaraFrontend et EkvaraCoachFrontend
# (déduit de l'emplacement du script, quel que soit le dossier courant).
DEV_DIR="${DEV_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
API_URL="https://api.$EKVARA_DOMAIN"

publish() {
  local dir="$1" target="$2"
  echo "== $dir -> $PI:/srv/ekvara/$target (API $API_URL)"
  (cd "$dir" && npm ci && npx vitest run --retry=2 && VITE_API_URL="$API_URL" npm run build)
  rsync -az --delete "$dir/dist/" "$PI:/srv/ekvara/$target/"
}

publish "$DEV_DIR/EkvaraFrontend/ekvarafrontend" athlete
publish "$DEV_DIR/EkvaraCoachFrontend" coach
echo "OK : https://app.$EKVARA_DOMAIN et https://coach.$EKVARA_DOMAIN publiés."
