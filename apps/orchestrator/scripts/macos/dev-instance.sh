#!/usr/bin/env bash
set -euo pipefail

NAME="${1:-alt}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$APP_DIR"

NODE24="$(ls -d "$HOME"/.nvm/versions/node/v24.*/bin 2>/dev/null | tail -1)"
if [ -n "$NODE24" ] && [ -x "$NODE24/node" ]; then
  export PATH="$NODE24:$PATH"
elif [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  . "$NVM_DIR/nvm.sh"
  nvm use >/dev/null 2>&1 || true
fi

if [ ! -x node_modules/.bin/electron-vite ]; then
  echo "✗ Dependencies not installed. Run: corepack pnpm@10.34.9 install" >&2
  exit 1
fi

node scripts/dev-instance.mjs "$NAME" &
LAUNCHER=$!

own_electron_pids() {
  pgrep -P "$LAUNCHER" 2>/dev/null || true
}

stop_instance() {
  trap - EXIT INT TERM
  local electron
  electron="$(own_electron_pids)"
  kill -9 "$LAUNCHER" 2>/dev/null || true
  for pid in $electron; do kill -TERM "$pid" 2>/dev/null || true; done
  for _ in $(seq 1 80); do
    local alive=""
    for pid in $electron; do kill -0 "$pid" 2>/dev/null && alive=1; done
    [ -z "$alive" ] && break
    sleep 0.3
  done
  for pid in $electron; do kill -9 "$pid" 2>/dev/null || true; done
}

trap 'echo; echo "⏹  Stopping dev instance ${NAME}…"; stop_instance' INT TERM
trap stop_instance EXIT
wait "$LAUNCHER" || true
