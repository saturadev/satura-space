"""Freeze this server once Satura Space moves to another version underneath it.

Claude Code spawns this MCP once per session from a version-free path the installer overwrites in
place, and an app update deliberately keeps agent terminals alive — so a session that spans an
update keeps driving a newer engine with the previous release's server, silently. Nothing can
reload a live stdio server; the only fix is restarting the agent.

Two on-disk markers say what is installed *now*, both written by the orchestrator:
``Packages/com.saturaspace.engine/.satura-engine.json`` (``{"buildId": "prod@X.Y.Z"}``, stamped
inside the atomic engine swap) and ``.sspace/.satura-app.json`` (``{"prod": "X.Y.Z"}``, refreshed on
every ensureProjectEnv).

Only a marker that has moved AHEAD of this server freezes it. The other direction — this server
newer than what is installed — is a state the orchestrator creates deliberately and heals itself:
it defers the engine swap while an editor is live and retries on the next launch, so a freshly
spawned post-update server routinely sees the old engine for a while. Freezing there would brick
the session the user just restarted, and restarting again would not help.

Missing, torn, or unorderable versions FAIL OPEN: never block on a project the app has not touched.
``SATURA_MCP_SKIP_VERSION_CHECK=1`` disables the guard outright.
"""
import functools
import json
import os
import re
import sys
from pathlib import Path

_SKIP_ENV = "SATURA_MCP_SKIP_VERSION_CHECK"
_ENGINE_PKG = "com.saturaspace.engine"
_ENGINE_STAMP = ".satura-engine.json"
_APP_STAMP = ".satura-app.json"
_ENGINE_SOURCE = f"Packages/{_ENGINE_PKG}"
_APP_SOURCE = f".sspace/{_APP_STAMP}"
_NUMERIC_PREFIX = re.compile(r"^(\d+(?:\.\d+)*)")

_warned = False


def channel() -> str:
    """Which build stamped a marker: the frozen exe ships with the app, source runs are dev.
    Mirrors ``app.isPackaged`` in the orchestrator's engineBuildId()."""
    return "prod" if getattr(sys, "frozen", False) else "dev"


def _read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _ordinal(version: str) -> tuple[int, ...] | None:
    m = _NUMERIC_PREFIX.match(version.strip())
    return tuple(int(p) for p in m.group(1).split(".")) if m else None


def _moved_ahead(found: str, mine: str) -> bool:
    """True only on positive evidence that what is installed is NEWER than this server."""
    a, b = _ordinal(found), _ordinal(mine)
    return bool(a and b and a > b)


def _pkg_version(path: Path) -> str | None:
    data = _read_json(path)
    if not data:
        return None
    return str(data.get("version") or "").strip() or None


def _baked_version() -> str | None:
    try:
        from ._build_info import VERSION
    except ImportError:
        return None
    return str(VERSION or "").strip() or None


def _repo_engine_version() -> str | None:
    return _pkg_version(Path(__file__).resolve().parents[2] / "saturaspace-engine" / "package.json")


@functools.lru_cache(maxsize=1)
def self_version() -> str | None:
    """This server's own product version: baked in at freeze time, or read from the repo the
    sources live in. None when neither is available, which disables the guard."""
    if getattr(sys, "frozen", False):
        return _baked_version()
    return _repo_engine_version() or _baked_version()


def _roots(root: Path) -> list[Path]:
    """The project itself, preceded by its parent when ``root`` is a scratchpad — the parent
    is where the app writes, so its markers are the authoritative ones."""
    from . import scratchpads

    parent = scratchpads.main_root(str(root))
    return [parent, root] if parent != root else [root]


def engine_version(root: Path) -> str | None:
    """Version of the engine package injected into the project, from its build stamp. The channel
    half of the buildId is dropped: a dev build and a prod build of the same version interoperate."""
    for r in _roots(root):
        data = _read_json(r / "Packages" / _ENGINE_PKG / _ENGINE_STAMP)
        if not data:
            continue
        build_id = str(data.get("buildId") or "").strip()
        version = build_id.split("@", 1)[1] if "@" in build_id else build_id
        if version.strip():
            return version.strip()
    return None


def app_version(root: Path) -> str | None:
    """Version of the Satura Space app that last touched this project, for OUR channel only — a dev
    app and a released app can manage the same project without flapping each other's sessions."""
    ch = channel()
    for r in _roots(root):
        data = _read_json(r / ".sspace" / _APP_STAMP)
        if not data:
            continue
        version = str(data.get(ch) or "").strip()
        if version:
            return version
    return None


def _warn_unknown_self() -> None:
    global _warned
    if _warned:
        return
    _warned = True
    print("[satura-space] version guard off: this server's own version is unknown", file=sys.stderr)


def _message(mine: str, found: str, source: str) -> str:
    return (
        "ERROR: Satura Space was updated while this session was running — its MCP tools are frozen.\n"
        f"  this MCP server: {mine}\n"
        f"  Satura Space now: {found} ({source})\n"
        "This server cannot reload itself, so every Satura tool will keep failing for the rest of "
        "this session. Ask the user to restart this agent — close and reopen the terminal in Satura "
        "Space, or exit and run `claude` again. Do not retry."
    )


def stale_message(project_root: str) -> str | None:
    """The refusal every tool returns once this server is out of date, or None while it is current.

    Re-read every call rather than latched: the markers are three tiny files, and a verdict cached
    for the life of the process would outlive the mismatch that produced it."""
    if os.environ.get(_SKIP_ENV):
        return None
    mine = self_version()
    if not mine:
        _warn_unknown_self()
        return None
    root = Path(project_root)
    for source, found in (
        (_ENGINE_SOURCE, engine_version(root)),
        (_APP_SOURCE, app_version(root)),
    ):
        if found and _moved_ahead(found, mine):
            return _message(mine, found, source)
    return None
