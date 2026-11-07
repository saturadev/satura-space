#!/usr/bin/env bash
# Set up the Satura Space MCP server's Python environment: create the venv and
# install deps. The server itself is launched by Claude Code via your .mcp.json
# (which runs .venv/bin/python server.py), so this script only prepares the venv.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

PYTHON="$(command -v python3 || command -v python || true)"
if [ -z "$PYTHON" ]; then
    echo "ERROR: Python 3 not found" >&2
    exit 1
fi

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating venv..."
    "$PYTHON" -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"

if ! python -c "import mcp; import yaml" 2>/dev/null; then
    echo "Installing dependencies..."
    pip install -q -r "$SCRIPT_DIR/requirements.txt"
fi

echo "Ready. The MCP server is launched by Claude Code via your .mcp.json (.venv/bin/python server.py)."
