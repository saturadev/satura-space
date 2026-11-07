"""MCP tools for the one-Claude-per-project headless build/test workflow.

Each Claude instance owns one Unity project and one headless "build server" editor.
The editor auto-launches lazily on the first build/test. `project_root` defaults
to this MCP server's working directory.

Blocking lifecycle calls run in a worker thread so the event loop stays responsive.
"""
import asyncio
import os
import time
from pathlib import Path

from typing import Annotated

from pydantic import Field

from .params import ProjectRoot
from . import instances
from . import modal_status
from .constants import _STATUS_STALE_THRESHOLD
from .file_lock import project_editor_lock
from .helpers import default_root, tool_guard
from .multiplayer import (
    STOPPED_NOTE,
    orchestrator_present,
    orchestrator_stopped,
    players_summary,
    request_player_command,
    scene_lines,
)

_SCENE_KEYS = ("activeScene", "activeSceneName", "scenesDirty", "scenes")

def _root(project_root: str) -> str:
    return os.path.abspath(os.path.expanduser(project_root or default_root()))

def _fmt(d: dict) -> str:
    return "\n".join(f"  {k}: {str(v).lower() if isinstance(v, bool) else v}" for k, v in d.items()
                     if k != "ok" and not isinstance(v, (list, dict)))

async def _lifecycle_line(root: str) -> str:
    if not orchestrator_present(root):
        return ""
    r = await request_player_command(root, "status", timeout=5.0)
    text = r.get("lifecycleText") if isinstance(r, dict) else None
    return text if isinstance(text, str) else ""

@tool_guard
async def unity_editor_status(
    lifecycle: Annotated[bool, Field(description="Start with the app's Unity lifecycle line when Satura Space runs the project.")] = True,
    project_root: ProjectRoot = "",
) -> str:
    root = _root(project_root)
    if not (Path(root) / "Assets").is_dir():
        return f"ERROR: Not a Unity project: {root}"
    head = await _lifecycle_line(root) if lifecycle else ""
    h = await asyncio.to_thread(instances.editor_health, root)
    lines = [f"Editor [{h['state']}] for {root}",
             _fmt({k: v for k, v in h.items() if k not in _SCENE_KEYS})]
    if head:
        lines.insert(0, head)
    if h["state"] == "DOWN" and orchestrator_stopped(root):
        lines.append(f"  STOPPED: {STOPPED_NOTE}")
    if h["state"] != "DOWN":
        dialogs = await asyncio.to_thread(modal_status.active_dialogs, Path(root))
        if dialogs:
            lines.append(
                "  BLOCKED BY DIALOG: a modal dialog is blocking this editor's main thread — "
                "resolve it with unity.answer():"
            )
            for d in dialogs:
                lines.extend(modal_status.describe_dialog(d, indent="    "))
        status = await asyncio.to_thread(instances._read_status, Path(root))
        age = time.time() - (status or {}).get("timestamp", 0) if status else None
        if status and status.get("pid") != h.get("pid"):
            lines.append(
                f"  NOTE: .mcp_status.json was written by another process (pid {status.get('pid')}), not this "
                "editor, so its scene/mode data is not shown."
            )
        elif age is not None and age > _STATUS_STALE_THRESHOLD:
            lines.append(
                f"  NOTE: status heartbeat is {int(age)}s old — the scene/mode data below may be "
                "stale (the editor is compiling, frozen, or backgrounded)."
            )
        lines.extend(scene_lines(h))
        n_errs, first_err = await asyncio.to_thread(instances.compile_error_summary, root)
        if n_errs:
            lines.append(f"  compile errors: {n_errs} (latest: {first_err[:200]})")
    log = Path(root) / ".sspace" / ".mcp_editor.log"
    if h["state"] != "DOWN" and log.exists():
        tail = log.read_text(encoding="utf-8", errors="replace").splitlines()[-8:]
        lines.append("  --- .mcp_editor.log tail ---\n" + "\n".join("  " + ln for ln in tail))
    lines.append(players_summary(root))
    return "\n".join(lines)

@tool_guard
async def unity_shutdown(
    force: Annotated[bool, Field(description="Without the Satura Space app only: kill the editor instead of quitting it gracefully.")] = False,
    timeout_seconds: Annotated[int, Field(description="Seconds to wait for the editors to quit.")] = 60,
    project_root: ProjectRoot = "",
) -> str:
    root = _root(project_root)
    if orchestrator_present(root):
        return await _stop_through_orchestrator(root, timeout_seconds)
    async with project_editor_lock(Path(root), timeout_seconds, op="shutdown") as acquired:
        if not acquired:
            return (
                "BUSY: another editor operation is still running for this project — not shutting the "
                "editor down underneath it. Wait for it to finish (or pass { force: true } after it clears), "
                "then retry."
            )
        health = await asyncio.to_thread(instances.editor_health, root)
        refused = instances.kill_refusal(health)
        if refused:
            return refused
        r = await asyncio.to_thread(instances.shutdown, root, force, timeout_seconds)
        return r.get("message", _fmt(r))

async def _stop_through_orchestrator(root: str, timeout_seconds: int) -> str:
    r = await request_player_command(root, "stop_editor", timeout=float(max(int(timeout_seconds), 1)))
    if r.get("error") in ("no_orchestrator", "timeout"):
        return (
            f"Stop requested, but Satura Space did not confirm it within {timeout_seconds}s. It may still "
            "be closing the editors (a launch in progress finishes first). Check unity.status()."
        )
    if not r.get("ok"):
        return f"STOP FAILED: {r.get('error', 'unknown')}"
    head = r.get("note") or "Unity stopped."
    return f"{head} unity.relaunch() starts it again.\n{players_summary(root)}"
