#!/usr/bin/env bash
# Lokaler Start mit Demodaten (macOS / Linux). Doppelklick oder: bash start.sh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js fehlt. Bitte von https://nodejs.org installieren (Version 22 oder neuer)."; exit 1
fi
[ -d node_modules ] || npm install --no-audit --no-fund
( sleep 2; command -v open >/dev/null && open http://localhost:3000 || command -v xdg-open >/dev/null && xdg-open http://localhost:3000 ) &
npm run demo
