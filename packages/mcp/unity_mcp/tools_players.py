"""``unity.relaunch()``, and the hot-reload arming behind ``unity.play(scene, { hotReload: true })``.

Clone lifecycle is the orchestrator's (it owns the fragile MPPM recipe), so these tools ASK the
orchestrator over the ``.sspace`` command channel and never launch a clone directly. Agents add or
remove players and change the stream through the app; see the live set in ``unity.refresh()`` /
``unity.status()``.
"""
import asyncio
import os
import time
from pathlib import Path

from typing import Annotated

from pydantic import Field

from .params import ProjectRoot
from . import instances
from .command_await import await_command
from .command_log import enqueue
from .editor_watch import MAX_WAIT_SECONDS
from .file_lock import project_editor_lock
from .helpers import default_root, tool_guard
from .input_gate import HEAD
from .multiplayer import (
    discover_players,
    orchestrator_drives,
    orchestrator_present,
    players_summary,
    request_player_command,
    require_player_panel,
    select_targets,
)
from .op_await import DONE

def _root(project_root: str) -> str:
    return os.path.abspath(os.path.expanduser(project_root or default_root()))

_NO_ORCH = (
    "No orchestrator is managing this project — open it in Satura Space "
    "(this acts on the streamed Player panels, which only the orchestrator runs)."
)

_ARM_RETRY_WINDOW = 15.0

async def _heartbeat_playing(root: str, target: str) -> bool:
    """True when any targeted editor's own heartbeat says isPlaying — ground truth that can lead the
    orchestrator's observed snapshot during the play-entry transition."""
    players = await asyncio.to_thread(discover_players, root)
    sel = select_targets(players, target) or players
    for p in sel:
        health = await asyncio.to_thread(instances.editor_health, p["dir"])
        if health.get("isPlaying"):
            return True
    return False

async def _arm_should_retry(root: str, target: str, r: dict) -> bool:
    if r.get("retryable") or "transitioning into Play" in (r.get("error") or ""):
        return True
    if "compile error" in (r.get("error") or ""):
        return False
    if "No targeted player is in Play Mode" not in (r.get("error") or ""):
        return False
    return await _heartbeat_playing(root, target)

async def arm_hot_reload(root: str, target: str = "all") -> str:
    """Arm live C# hot reload on the targeted players — the Player panel's Hot Reload toggle.
    Arm-only and idempotent; Play Mode only (the editor disarms on Stop). Retries for ~15s so it
    tolerates the play-entry transition right after unity.openScene() enters Play."""
    msg = require_player_panel(root)
    if msg:
        return msg
    if not await orchestrator_drives(root):
        return await _arm_hot_reload_direct(root, target)
    r = await request_player_command(root, "arm_hotreload", extra={"target": target})
    if r.get("error") == "no_orchestrator":
        return _NO_ORCH
    deadline = time.monotonic() + _ARM_RETRY_WINDOW
    while (
        not r.get("ok")
        and time.monotonic() < deadline
        and await _arm_should_retry(root, target, r)
    ):
        await asyncio.sleep(1.0)
        r = await request_player_command(root, "arm_hotreload", extra={"target": target})
    if not r.get("ok"):
        return f"ARM HOT RELOAD FAILED: {r.get('error', 'unknown')}"
    note = r.get("note")
    head = f"Hot reload armed ({note})" if note else "Hot reload armed."
    return head + "\n" + players_summary(root)

async def _arm_hot_reload_direct(root: str, target: str) -> str:
    """Arm hot reload on editors this MCP drives directly (no orchestrator instance for the project):
    enqueue ``setHotReload`` on each targeted playing editor and await its ack. The hot-reload package
    does its own file watching once enabled, so arming is all a standalone editor needs."""
    players = await asyncio.to_thread(discover_players, root)
    sel = select_targets(players, target) or players
    if not sel:
        return (
            "ARM HOT RELOAD FAILED: no running editor for this project.\n"
            "Call unity.relaunch() first, then unity.play(scene, { hotReload: true })."
        )
    playing = [p for p in sel if p.get("isPlaying")]
    if not playing:
        return (
            "ARM HOT RELOAD FAILED: No targeted player is in Play Mode — call "
            "unity.play(scene, { hotReload: true }) again."
        )
    lines = []
    armed = 0
    for p in playing:
        pdir = Path(p["dir"])
        enq = await enqueue(pdir, "setHotReload", {"enabled": True})
        if enq.get("error"):
            lines.append(f"  Player {p['index'] + 1}: {enq['error']}")
            continue
        outcome = await await_command(pdir, enq["cmdId"], kind="setHotReload", timeout_seconds=30)
        if outcome.kind == DONE:
            armed += 1
            lines.append(f"  Player {p['index'] + 1}: armed")
        else:
            lines.append(f"  Player {p['index'] + 1}: {outcome.detail or outcome.kind}")
    head = "Hot reload armed." if armed == len(playing) else (
        f"ARM HOT RELOAD: {armed}/{len(playing)} armed." if armed else "ARM HOT RELOAD FAILED."
    )
    return "\n".join([head, *lines, players_summary(root)])

async def _relaunch_headless(root: str, timeout_seconds: int) -> str:
    """No-orchestrator fallback for unity.relaunch(): kill this project's headless editor (if any) and
    launch a fresh batchmode one directly, blocking until its status heartbeat arms. Refuses to touch
    a GUI editor — that one belongs to the user. Holds ``project_editor_lock`` for the whole
    check-kill-launch sequence so two concurrent relaunches can never double-launch into one project
    (ensure_editor deletes ``Temp/UnityLockfile`` — unserialized, that deletes the OTHER relaunch's
    freshly created lockfile)."""
    async with project_editor_lock(Path(root), min(timeout_seconds, 120), op="relaunch") as acquired:
        if not acquired:
            return (
                "BUSY: another editor operation (or relaunch) is already running for this project. "
                "Wait for it to finish, then retry."
            )
        return await _relaunch_headless_locked(root, timeout_seconds)

async def _relaunch_headless_locked(root: str, timeout_seconds: int) -> str:
    health = await asyncio.to_thread(instances.editor_health, str(root))
    notes: list[str] = []
    if health.get("state") != "DOWN":
        if health.get("isBatchMode") is False:
            return (
                f"A GUI Unity editor (pid {health.get('pid')}) already holds this project — refusing to "
                "kill it. unity.exec, unity.refresh and unity.openScene attach to it directly, so just drive that editor; or "
                "close it and retry to get a headless batchmode editor instead."
            )
        refused = instances.kill_refusal(health)
        if refused:
            return refused
        killed = await asyncio.to_thread(instances.shutdown, root, True, 30)
        if killed.get("refused") or not killed.get("ok"):
            return killed.get("message") or "RELAUNCH FAILED: the previous headless editor didn't stop."
        notes.append(killed.get("message", "Killed the previous headless editor."))

    ens = await asyncio.to_thread(instances.ensure_editor, root, "", "", max(int(timeout_seconds), 30), 0)
    if not ens.get("ok"):
        if ens.get("dialog_block"):
            return "\n".join(
                notes
                + [
                    "BLOCKED BY DIALOG: the launching editor raised a modal dialog and cannot "
                    "finish starting up.",
                    ens["dialog_block"],
                    "Resolve the dialog, then poll unity.logs() / unity.status() to confirm the "
                    "editor finishes booting (or call unity.relaunch() again).",
                ]
            )
        if str(ens.get("error", "")).startswith(HEAD):
            return "\n".join([ens["error"]] + notes)
        body = "\n".join(notes + [f"HEADLESS LAUNCH FAILED: {ens.get('error', 'unknown')}"])
        return (
            body
            + "\nPoll unity.at(project).logs() to watch startup and catch compile/startup errors."
        )
    if ens.get("dialog_note"):
        notes.append(f"NOTE: {ens['dialog_note']}")
    head = "Headless batchmode editor is up (no orchestrator — launched directly; heartbeat armed"
    head += f", {ens.get('armed_seconds')}s)." if ens.get("armed_seconds") is not None else ")."
    tail = (
        "It stays resident until unity.shutdown() (idle-quit disabled) and burns ~1 core even when "
        "idle — shut it down when you're done. "
        "Next: unity.refresh() to compile, then unity.exec and unity.openScene as usual."
    )
    return "\n".join(notes + [head, tail, players_summary(root)])

@tool_guard
async def unity_relaunch(
    timeout_seconds: Annotated[int, Field(description="Seconds to wait for the new editor, a Unity Hub install of the project's version included. A first boot without a Library folder needs 600 or more.")] = 180,
    project_root: ProjectRoot = "",
) -> str:
    root = _root(project_root)
    if not orchestrator_present(root):
        return await _relaunch_headless(root, min(int(timeout_seconds), MAX_WAIT_SECONDS))
    wait = max(int(timeout_seconds), 1)
    async with project_editor_lock(Path(root), 2.0, op="relaunch"):
        r = await request_player_command(root, "relaunch", extra={"wait": wait}, timeout=float(wait) + 60.0)
    if r.get("error") == "no_orchestrator":
        return _NO_ORCH
    if r.get("error") == "timeout":
        if r.get("detail"):
            return f"TIMEOUT: {r['detail']}"
        return (f"TIMEOUT: Satura Space didn't answer the relaunch within {wait + 60} s. "
                "Check unity.status() before you call it again.")
    if not r.get("ok"):
        err = str(r.get("error") or "unknown")
        return err if err.startswith((HEAD, "RELAUNCH FAILED", "TIMEOUT", "BLOCKED BY DIALOG")) else f"RELAUNCH FAILED: {err}"
    return f"{r.get('note') or 'Unity is ready.'}\n{players_summary(root)}"
