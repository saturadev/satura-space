#!/usr/bin/env bash
#
# Launch the Satura Space orchestrator in dev mode.
#
# Wraps the project's run quirks:
#   - Node >= 20 (the machine default may be 18; Tailwind v4 + electron-vite refuse it).
#   - Uses the local electron-vite binary (pnpm is not on PATH here).
#   - Kills any stale dev server before starting (each `electron-vite dev` spawns a
#     supervisor that RESPAWNS Electron, so stacked runs multiply windows).
#   - Cleanly tears down the dev server, Electron, and orphaned PTY login shells on exit
#     (Ctrl-C), since a hard kill skips Electron's own shell reaper.
#
# Usage:  ./dev.sh
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$APP_DIR"

NODE24="$(ls -d "$HOME"/.nvm/versions/node/v24.*/bin 2>/dev/null | tail -1)"
if [ -n "$NODE24" ] && [ -x "$NODE24/node" ]; then
  export PATH="$NODE24:$PATH"
elif [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use >/dev/null 2>&1 || true
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "✗ Node >= 24 required (found $(node -v 2>/dev/null || echo 'none'))." >&2
  echo "  Install it (e.g. 'nvm install 24') and retry." >&2
  exit 1
fi

# --- Dependencies present? ---------------------------------------------------
if [ ! -x node_modules/.bin/electron-vite ]; then
  echo "✗ Dependencies not installed. Run: corepack pnpm install" >&2
  exit 1
fi

# --- Teardown ----------------------------------------------------------------
ELECTRON_PAT="$APP_DIR/node_modules/.pnpm/electron@"

# The pty daemon runs as electron-as-node with 'daemon-entry' in its command line and is
# detached (reparented to launchd). It OWNS every terminal shell. Leave it — and its
# '/bin/zsh -l' shells — running across a restart so the next launch reattaches to your
# live terminals (exact state, mid-line input) instead of respawning them. Only the GUI
# Electron + the electron-vite supervisor are torn down.
is_daemon_pid() { pgrep -f 'daemon-entry' 2>/dev/null | grep -qx "$1"; }
is_dev_instance_pid() { ps -E -p "$1" -o command= 2>/dev/null | grep -q 'SATURA_DEV_INSTANCE='; }
gui_electron_pids() {
  for pid in $(pgrep -f "$ELECTRON_PAT" 2>/dev/null); do
    is_daemon_pid "$pid" || is_dev_instance_pid "$pid" || printf '%s\n' "$pid"
  done
}
supervisor_pids() {
  for pid in $(pgrep -f "electron-vite.js dev" 2>/dev/null); do
    is_dev_instance_pid "$pid" || printf '%s\n' "$pid"
  done
}
stop_servers() {
  # Kill the supervisor FIRST (NB: the real cmdline is 'electron-vite.js dev') so it can't respawn
  # Electron mid-shutdown, then SIGTERM the GUI Electron so its before-quit runs the graceful Unity
  # close (quit trigger -> EditorApplication.Exit(0), no leftover scene backups). SIGKILL as fallback.
  for pid in $(supervisor_pids); do kill -9 "$pid" 2>/dev/null || true; done
  for pid in $(gui_electron_pids); do kill -TERM "$pid" 2>/dev/null || true; done
  for _ in $(seq 1 30); do
    [ -z "$(gui_electron_pids)" ] && break
    sleep 0.3
  done
  for pid in $(gui_electron_pids); do kill -9 "$pid" 2>/dev/null || true; done
}
stop_all() {
  stop_servers
  # Deliberately DO NOT kill the daemon or its '/bin/zsh -l' shells — they survive so the
  # next run warm-reattaches to your terminals. To force a fully clean slate (e.g. after a
  # daemon-code change), run:  pkill -f daemon-entry; pkill -f '^/bin/zsh -l$'
}

# Clear any stale dev server from a previous run so they don't stack / respawn Electron.
stop_servers
trap 'echo; echo "⏹  Stopping orchestrator…"; stop_all' EXIT

echo "▶  Launching Satura Space orchestrator (Node $(node -v))…"
echo "   Press Ctrl-C to quit and tear everything down."
node_modules/.bin/electron-vite dev
