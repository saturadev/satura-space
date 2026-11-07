import asyncio
import itertools
import json
import math
import re
import time
from pathlib import Path

from typing import Annotated

from mcp.server.fastmcp import Image
from pydantic import Field

from . import instances
from .constants import _STATUS_STALE_THRESHOLD
from .op_await import DIALOG_BLOCKED, EDITOR_DIED, DONE, ERROR, UNAVAILABLE, OpOutcome
from .command_log import ack_for, enqueue, enqueue_retry, read_acks
from .command_await import await_command
from . import modal_status
from .editor_ready import DIALOG_REASON_PREFIX, EARLY_PREFIX, await_editor_ready
from .editor_watch import unavailable_message
from .exec_readonly import snippet_is_read_only
from .file_lock import project_editor_lock, stale_holder
from .helpers import _focus_unity, is_headless, pid_alive, resolve_root, tool_guard
from .multiplayer import (
    no_editor_message,
    STOPPED_NOTE,
    discover_players,
    player_label,
    format_player_line,
    players_summary,
    orchestrator_drives,
    orchestrator_present,
    orchestrator_stopped,
    request_player_command,
    require_player_panel,
    scratchpad_id,
    select_targets,
)
from .params import ProjectRoot
from .sspace import ensure_sspace, ensure_sspace_for

def _read_status_file(root: Path) -> dict | None:
    """Parse .mcp_status.json regardless of staleness, or None if missing/unreadable."""
    status_file = root / ".sspace" / ".mcp_status.json"
    if not status_file.exists():
        return None
    try:
        return json.loads(status_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, IOError):
        return None

def _read_unity_status_raw(root: Path) -> dict | None:
    """Read .mcp_status.json. Returns dict or None if missing/stale."""
    data = _read_status_file(root)
    if data is None:
        return None
    ts = data.get("timestamp", 0)
    if abs(time.time() - ts) > _STATUS_STALE_THRESHOLD:
        return None
    return data

def _read_unity_status(root: Path) -> dict | None:
    """Read .mcp_status.json with auto-wakeup.

    Unity throttles EditorApplication.update when its window is minimized or
    in the background, so .mcp_status.json goes stale and pre-flight checks
    incorrectly report "Unity not running". On stale/missing status, force
    the Unity window to the foreground and re-poll briefly.
    """
    data = _read_unity_status_raw(root)
    if data is not None:
        return data
    if is_headless(str(root)):
        stale = _read_status_file(root)
        if stale is not None and pid_alive(stale.get("pid", 0)):
            return stale
    _focus_unity(str(root))
    deadline = time.time() + 3.0
    while time.time() < deadline:
        time.sleep(0.2)
        data = _read_unity_status_raw(root)
        if data is not None:
            return data
    return None

async def _ensure_unity_up(root: Path) -> str | None:
    """Require a LIVE editor for this project — never launch one here.

    Exec ATTACHES to whatever editor already owns the project: the orchestrator-launched editor, a
    user's GUI editor, or a headless batchmode editor launched via unity.relaunch() (no-orchestrator
    mode). Returns an error string telling the caller how to get one up if none is running, else None.
    """
    down = await unavailable_message(root)
    if down:
        return f"ERROR: {down}"
    for attempt in range(3):
        health = await asyncio.to_thread(instances.editor_health, str(root))
        if health.get("state") != "DOWN":
            return None
        if attempt < 2:
            await asyncio.sleep(0.5)
    if orchestrator_stopped(str(root)):
        return f"ERROR: exec needs a live editor to run in. {STOPPED_NOTE}"
    if orchestrator_present(str(root)):
        return (
            "ERROR: No Unity editor is open for this project — exec needs a live editor to run in.\n"
            "The Satura Space orchestrator manages this project: open its Unity Player panel (or call "
            "unity.relaunch() to have the orchestrator restart the group), then retry."
        )
    return f"ERROR: {no_editor_message(str(root))}"

def _check_is_playing(root: Path) -> bool | None:
    """Return True if playing, False if not, None if status unknown."""
    status = _read_unity_status(root)
    if status is None:
        return None
    return bool(status.get("isPlaying"))

def _check_is_compiling(root: Path) -> bool | None:
    """Return True if compiling, False if not, None if status unknown."""
    status = _read_unity_status(root)
    if status is None:
        return None
    return bool(status.get("isCompiling"))

def _clean_compile_stamp(root: Path) -> int | None:
    """mtime_ns of the engine's clean-compile stamp — advances only when a compilation actually ran
    and finished clean, so comparing it across a refresh distinguishes recompile from no-op."""
    try:
        return (root / ".sspace" / ".mcp_last_clean_compile").stat().st_mtime_ns
    except OSError:
        return None

@tool_guard
async def unity_open_scene(
    scene_path: Annotated[str, Field(description='Relative to the project root, e.g. "Assets/Scenes/Main.unity".')],
    enter_play_mode: Annotated[bool, Field(description="Enter Play Mode after opening.")] = False,
    hot_reload: Annotated[bool, Field(description="Arm C# hot reload once playing. Needs enter_play_mode.")] = False,
    refresh: Annotated[bool, Field(description="false skips the compile before opening. Edit Mode only.")] = True,
    timeout_seconds: Annotated[int, Field(description="Seconds to wait per player. The refresh has its own 300 s ceiling.")] = 60,
    poll_interval: Annotated[float, Field(description="Seconds between status checks. Rarely needed.")] = 0.25,
    unsaved: Annotated[str, Field(description='What to do with unsaved scene changes: "save" or "discard". Without it, unsaved changes stop the switch with an error.')] = "",
    project_root: ProjectRoot = "",
) -> str:
    if unsaved not in ("", "save", "discard"):
        return 'ERROR: unsaved is "save" or "discard".'
    if hot_reload and not enter_play_mode:
        return "ERROR: hotReload needs Play: use unity.play(scene, {hotReload: true})."
    blocked, startup_note = await _startup_dialogs(project_root, timeout_seconds, poll_interval)
    if blocked:
        return blocked
    text, played = await _open_scene(
        project_root, scene_path, enter_play_mode, timeout_seconds,
        poll_interval, refresh, keep_playing=hot_reload, unsaved=unsaved,
    )
    text = startup_note + text
    if not hot_reload:
        return text
    if not played:
        return text + "\n\nHot reload NOT armed: Play Mode was not confirmed on every player."
    from .tools_players import arm_hot_reload
    return text + "\n\n" + await arm_hot_reload(resolve_root(project_root), "all")

async def _startup_dialogs(project_root: str, timeout_seconds: float, poll_interval: float) -> tuple[str, str]:
    """A dialog shown while the editor starts (Scene Backup after a crash) blocks it before the bridge
    is up, so no player is discoverable yet. Answer a known-safe one and wait for the editor, or report
    it. Returns (blocked report or "", note to prepend)."""
    root = Path(resolve_root(project_root))
    if discover_players(str(root)):
        return "", ""
    dialogs = await asyncio.to_thread(modal_status.active_dialogs, root)
    if not dialogs:
        return "", ""
    answered, left = await modal_status.answer_safe(root, dialogs)
    if left:
        return "BLOCKED BY DIALOG:\n" + modal_status.dialog_block(root, left), ""
    deadline = time.monotonic() + timeout_seconds
    while not discover_players(str(root)) and time.monotonic() < deadline:
        await asyncio.sleep(poll_interval)
    return "", f"Answered {', '.join(answered)} while the editor was starting.\n"

def _play_confirmed(results: list) -> bool:
    return bool(results) and all(
        out.get("scene_msg")
        and out.get("scene_error") is None
        and not out.get("dialog_blocked")
        and not out.get("scene_timeout")
        for _p, _r, out in results
    )

def _already_playing(players: list, scene_path: str) -> bool:
    want = scene_path.replace("\\", "/")
    return bool(players) and all(
        p.get("isPlaying") and (p.get("activeScene") or "").replace("\\", "/") == want
        for p in players
    )

async def _open_scene(
    project_root: str,
    scene_path: str,
    enter_play_mode: bool,
    timeout_seconds: int,
    poll_interval: float,
    refresh: bool,
    *,
    keep_playing: bool = False,
    unsaved: str = "",
) -> tuple[str, bool]:
    project_root = resolve_root(project_root)
    root = Path(project_root)
    if not (root / "Assets").is_dir():
        return f"ERROR: Not a Unity project: {root}", False
    if not scene_path:
        return "ERROR: unity.openScene() needs the scene path, like \"Assets/Scenes/Main.unity\".", False
    if not scene_path.lower().endswith(".unity"):
        return f"ERROR: unity.openScene() opens a scene file (.unity), like \"Assets/Scenes/Main.unity\"; {scene_path} isn't one.", False
    if not (root / scene_path).exists():
        return f"ERROR: Scene file not found: {root / scene_path}", False

    panel = require_player_panel(str(root))
    if panel:
        return panel, False

    down = await unavailable_message(root)
    if down:
        return f"ERROR: {down}", False

    players = discover_players(str(root))
    if not players:
        return (
            "ERROR: No running Unity editor for this project.\n"
            "Open it (or the orchestrator's player group) first — this tool never launches one."
        ), False
    targets = players

    count = len(players)

    if keep_playing and _already_playing(players, scene_path):
        return (
            f"Already in Play Mode on {scene_path} ({count} player(s)) — kept the running session, "
            "no reload."
        ), True

    unsaved_err = await _resolve_unsaved_scenes(str(root), players, scene_path, enter_play_mode, unsaved)
    if unsaved_err:
        return unsaved_err, False

    if enter_play_mode and not refresh:
        n_errs, first_err = instances.compile_error_summary(str(root))
        if n_errs:
            return (
                f"ERROR: cannot enter Play Mode — the project has {n_errs} compile error(s) "
                f"(latest: {first_err[:200]}).\n"
                "Unity refuses Play Mode while scripts fail to compile; {refresh: false} only skips the "
                "pre-open refresh, it cannot bypass compile errors. Fix the errors and retry (the "
                "default refresh recompiles first), or use unity.openScene(path) to open "
                "the scene in Edit Mode despite the errors."
            ), False

    closed_note = _additive_close_note(players, scene_path, enter_play_mode)

    async with project_editor_lock(root, timeout_seconds, op="scene") as acquired:
        if not acquired:
            return _editor_busy_message(root, "scene", timeout_seconds), False

        routed = await orchestrator_drives(str(root))
        focus = (not routed) and count == 1 and players[0].get("isBatchMode") is False

        refresh_note = ""
        if refresh:
            refresh_err, refresh_note = await _refresh_before_scene(
                root, project_root, routed, focus=focus, play=enter_play_mode,
            )
            if refresh_err:
                return refresh_err, False

        if routed:
            cmd = await request_player_command(str(root), "scene", extra={
                "scenePath": scene_path, "enterPlayMode": enter_play_mode,
            })
            if not cmd.get("ok"):
                return (
                    f"ERROR (orchestrator scene): {cmd.get('error', 'unknown')}\n"
                    "Satura Space is managing this project but didn't apply the command. "
                    "Make sure the project's Unity Player panel is open and idle, then retry."
                ), False
            targets = _routed_targets(root, targets, cmd.get("players"))
            settle_err = None if enter_play_mode else await _settle_routed_scene(root, timeout_seconds, poll_interval)
            if settle_err:
                return settle_err, False
            results = await _confirm_routed_scene(targets, enter_play_mode, timeout_seconds, poll_interval, scene_path)
            cancel_note = ""
            need_cancel = enter_play_mode and any(
                out.get("scene_timeout") for _p, _r, out in results
            )
            if need_cancel:
                cancel = await request_player_command(str(root), "cancel_play")
                if cancel.get("ok"):
                    cancel_note = (
                        "\nThe timed-out Play request was CANCELLED — the group stays in Edit Mode and "
                        "will not enter Play Mode from this call later."
                    )
                else:
                    cancel_note = (
                        "\nWARNING: could not cancel the timed-out Play request "
                        f"({cancel.get('error') or 'unknown'}) — the group may still enter Play Mode "
                        "later on its own; run unity.stop() to be safe."
                    )
            text = _format_scene_results(results, scene_path, timeout_seconds)
            if any(out.get("scene_timeout") for _p, _r, out in results):
                text += _scene_timeout_diagnosis(root)
            if any(out.get("scene_msg") for _p, _r, out in results):
                text += closed_note
            text += cancel_note
            return text + refresh_note, enter_play_mode and _play_confirmed(results)

        async def _run(p: dict):
            out = await _open_scene_and_run(
                p["dir"], scene_path, enter_play_mode,
                focus=focus, timeout_seconds=timeout_seconds,
            )
            return p, p.get("role", ""), out

        results = await asyncio.gather(*[_run(p) for p in targets])
        text = _format_scene_results(results, scene_path, timeout_seconds)
        if any(out.get("scene_timeout") for _p, _r, out in results):
            text += _scene_timeout_diagnosis(root)
        if any(out.get("scene_msg") for _p, _r, out in results):
            text += closed_note
        return text + refresh_note, enter_play_mode and _play_confirmed(results)

def _switch_drops_edits(players: list, scene_path: str, enter_play_mode: bool) -> bool:
    primary = next((p for p in players if p.get("role") == "primary"), players[0] if players else None)
    if not primary or primary.get("isPlaying"):
        return False
    active = next((s for s in (primary.get("scenes") or []) if s.get("active")), None)
    same = bool(active) and (active.get("path") or "").replace("\\", "/") == scene_path.replace("\\", "/")
    return not (enter_play_mode and same)

async def _live_dirty_scenes(root: str) -> list[str] | None:
    code = (
        "for (int i = 0; i < UnityEngine.SceneManagement.SceneManager.sceneCount; i++) { "
        "var s = UnityEngine.SceneManagement.SceneManager.GetSceneAt(i); "
        "if (s.isLoaded && s.isDirty) Print(string.IsNullOrEmpty(s.path) ? s.name : s.path); }"
    )
    out = await _unity_exec_each(root, code, 30, "", "primary")
    if isinstance(out, str) or not out:
        return None
    from .exec_ops import parse_exec_text
    text, _notes = parse_exec_text(out[0][1])
    return [l.strip() for l in text.splitlines() if l.strip()]

async def _resolve_unsaved_scenes(root: str, players: list, scene_path: str, enter_play_mode: bool, unsaved: str) -> str:
    if unsaved == "discard" or not _switch_drops_edits(players, scene_path, enter_play_mode):
        return ""
    dirty = await _live_dirty_scenes(root)
    if dirty is None:
        primary = next((p for p in players if p.get("role") == "primary"), players[0])
        dirty = [s.get("path") or s.get("name") or "Untitled" for s in (primary.get("scenes") or []) if s.get("loaded") and s.get("dirty")]
    if not dirty:
        return ""
    names = ", ".join(dirty)
    if not unsaved:
        return (
            f"ERROR: unsaved changes in {names}, so the scene wasn't switched.\n"
            "Pass unsaved: \"save\" to save them first, or unsaved: \"discard\" to drop them and reload from disk."
        )
    out = await _unity_exec_each(
        root, "Print(UnityEditor.SceneManagement.EditorSceneManager.SaveOpenScenes());", 60, "", "primary",
    )
    if isinstance(out, str):
        return f"ERROR: could not save {names}: {out}"
    if not any("True" in text for _p, text in out):
        return f"ERROR: Unity did not save {names}, so the scene was not switched."
    return ""

def _additive_close_note(players: list, scene_path: str, enter_play_mode: bool) -> str:
    """Name the additive scenes a single-mode load closes — visible up-front from the pre-open status,
    since the load result itself only reports discarded UNSAVED scenes."""
    primary = next((p for p in players if p.get("role") == "primary"), players[0] if players else None)
    if not primary:
        return ""
    scenes = [s for s in (primary.get("scenes") or []) if s.get("loaded")]
    if len(scenes) <= 1:
        return ""
    active = next((s for s in scenes if s.get("active")), None)
    if enter_play_mode and active and active.get("path") == scene_path:
        return ""
    others = [
        s.get("path") or s.get("name") or "<untitled>"
        for s in scenes
        if (s.get("path") or "") != scene_path
    ]
    if not others:
        return ""
    return (
        "\nNOTE: the scene was opened in single mode, which CLOSED the other open scene(s): "
        + ", ".join(others)
        + ". Re-open them additively if needed (exec "
        "EditorSceneManager.OpenScene(path, OpenSceneMode.Additive))."
    )

def _scene_timeout_diagnosis(root: Path) -> str:
    parts = []
    n_errs, first_err = instances.compile_error_summary(str(root))
    if n_errs:
        parts.append(
            f"The editor reports {n_errs} compile error(s) (latest: {first_err[:200]}) — Unity refuses "
            "Play Mode while scripts fail to compile; fix the errors and retry."
        )
    dialog_note = modal_status.players_dialog_note(str(root))
    if dialog_note:
        parts.append(dialog_note)
    return ("\n" + "\n".join(parts)) if parts else ""

async def _open_scene_and_run(
    target_dir: str,
    scene_path: str,
    enter_play_mode: bool,
    *,
    focus: bool = True,
    timeout_seconds: int = 60,
) -> dict:
    """Drive ONE editor (rooted at target_dir) through open scene -> optional Play Mode, polling that
    editor's own command acks. Returns a structured outcome dict (formatted by
    _format_open_scene_outcome). `focus=False` skips _focus_unity for managed/headless editors."""
    root = Path(target_dir)

    def focus_now():
        if focus:
            _focus_unity(target_dir)

    tick = focus_now if focus else None

    out = {"dir": target_dir, "scene_msg": None, "scene_error": None, "scene_timeout": False}

    gen = int(time.time())
    scene_enq = await enqueue_retry(root, "loadScene", {"scene": scene_path, "gen": gen, "force": True})
    if scene_enq["error"]:
        out["scene_error"] = scene_enq["error"]
        return out
    focus_now()
    scene_outcome = await await_command(root, scene_enq["cmdId"], kind="loadScene",
                                        timeout_seconds=timeout_seconds, on_tick=tick)
    if scene_outcome.kind == DIALOG_BLOCKED:
        out["dialog_blocked"] = scene_outcome.detail
        return out
    if scene_outcome.kind == ERROR:
        out["scene_error"] = scene_outcome.detail or "Unknown error"
        return out
    if scene_outcome.kind == UNAVAILABLE or (scene_outcome.data or {}).get("noProgress"):
        out["scene_failed"] = scene_outcome.detail
        return out
    if scene_outcome.kind not in (DONE,):
        out["scene_timeout"] = True
        return out

    if not enter_play_mode:
        ack = ack_for(root, scene_enq["cmdId"]) or {}
        if ack.get("status") == "skipped":
            out["scene_msg"] = (
                f"Scene already open: {scene_path} (Edit Mode) — this editor kept the in-memory "
                "state, NO reload from disk happened (unsaved edits survive)"
            )
        else:
            out["scene_msg"] = f"Scene opened: {scene_path} (Edit Mode, loaded fresh from disk)"
        return out

    play_enq = await enqueue_retry(root, "play", {"gen": gen})
    if play_enq["error"]:
        out["scene_error"] = play_enq["error"]
        return out
    focus_now()
    play_outcome = await await_command(root, play_enq["cmdId"], kind="play",
                                       timeout_seconds=timeout_seconds, on_tick=tick)
    if play_outcome.kind == DIALOG_BLOCKED:
        out["dialog_blocked"] = play_outcome.detail
        return out
    if play_outcome.kind == ERROR:
        out["scene_error"] = play_outcome.detail or "Unknown error"
        return out
    if play_outcome.kind == UNAVAILABLE:
        out["scene_failed"] = play_outcome.detail
        return out
    if play_outcome.kind not in (DONE,):
        out["scene_timeout"] = True
        cancel = await enqueue_retry(root, "stop", {"gen": int(time.time())})
        out["play_cancelled"] = not cancel["error"]
        return out

    out["scene_msg"] = f"Scene opened: {scene_path} (Play Mode)"
    return out

def _format_open_scene_outcome(out: dict, scene_path: str, timeout_seconds: int) -> str:
    """Render _open_scene_and_run's outcome as unity.openScene()'s legacy string output."""
    if out.get("dialog_blocked"):
        return f"BLOCKED BY DIALOG:\n{out['dialog_blocked']}"
    if out["scene_error"] is not None:
        return f"ERROR opening scene: {out['scene_error']}"
    if out.get("scene_failed"):
        return f"ERROR: the scene wasn't opened. {out['scene_failed']}"
    if out["scene_timeout"]:
        msg = (
            f"TIMEOUT: Scene did not open within {timeout_seconds}s.\n"
            "Check that Unity Editor is open with this project and not stuck.\n"
            "Common causes: Unity is compiling, a dialog is blocking, or the scene path is wrong."
        )
        if out.get("play_cancelled"):
            msg += (
                "\nA stop was queued to CANCEL the timed-out Play request — the editor will not "
                "enter Play Mode from this call later."
            )
        elif out.get("play_cancelled") is False:
            msg += (
                "\nWARNING: the timed-out Play request could NOT be cancelled — the editor may still "
                "enter Play Mode later on its own; run unity.stop() to be safe."
            )
        return msg
    return out["scene_msg"]

def _format_scene_results(results: list, scene_path: str, timeout_seconds: int) -> str:
    if len(results) == 1:
        return _format_open_scene_outcome(results[0][2], scene_path, timeout_seconds)
    lines = [f"Scene '{scene_path}' across {len(results)} player(s):"]
    for p, role, out in results:
        lines.append("  " + format_player_line(p, role, out))
    return "\n".join(lines)

def _routed_targets(root: Path, fallback: list, players) -> list:
    """The player set the orchestrator actually fanned the scene command to, mapped to discover_players'
    entry shape. The pre-command discover_players snapshot can miss a clone whose bridge has not
    published a status file yet (open_scene right after add_player) — the orchestrator's own list is
    authoritative, and its ordering is the order the scene was fanned out in. Falls back to the snapshot
    when the response carries no usable list (older orchestrator)."""
    if not isinstance(players, list) or not players:
        return fallback
    out = []
    for i, info in enumerate(players):
        if not isinstance(info, dict) or info.get("kind") not in ("primary", "clone"):
            return fallback
        vp = info.get("vpId")
        if info.get("kind") == "clone" and not vp:
            return fallback
        out.append({"index": i, "role": info["kind"], "vpId": vp,
                    "dir": str(root / "Library" / "VP" / vp) if vp else str(root),
                    "pid": info.get("pid"), "state": "?"})
    return out

async def _settle_routed_scene(root: Path, timeout_seconds: float, poll_interval: float) -> str | None:
    deadline = time.monotonic() + max(timeout_seconds, 30)
    while True:
        r = await request_player_command(str(root), "scene_wait")
        err = str(r.get("error") or "")
        if r.get("ok") and r.get("note") != "loading":
            return None
        if not r.get("ok") and (err.startswith("Unknown action") or err in ("no_orchestrator", "timeout")):
            return None
        if not r.get("ok"):
            return f"ERROR: the scene didn't load: {err}"
        if time.monotonic() >= deadline:
            return f"TIMEOUT: the scene is still loading after {int(max(timeout_seconds, 30))} s. Check unity.status() and retry with a higher timeout."
        await asyncio.sleep(min(poll_interval, 0.25))


async def _confirm_routed_scene(targets, enter_play_mode, timeout_seconds, poll_interval, scene_path="") -> list:
    deadline = time.monotonic() + timeout_seconds

    async def confirm(p: dict):
        out = {"dir": p["dir"], "scene_msg": None, "scene_error": None, "scene_timeout": False}
        if enter_play_mode:
            playing = False
            answered: list[str] = []
            pdir = Path(p["dir"])
            while time.monotonic() < deadline:
                if (await asyncio.to_thread(instances.editor_health, p["dir"])).get("isPlaying"):
                    playing = True
                    break
                dialogs = await _confirmed_dialogs(pdir)
                if dialogs:
                    done, left = await modal_status.answer_safe(pdir, dialogs)
                    answered.extend(done)
                    if left:
                        out["dialog_blocked"] = modal_status.dialog_block(pdir, left, resumes=True)
                        break
                    continue
                await asyncio.sleep(poll_interval)
            note = f" after answering {', '.join(answered)}" if answered else ""
            out["scene_msg"] = f"Scene opened (Play Mode){note}" if playing else None
            out["scene_timeout"] = not playing and not out.get("dialog_blocked")
        else:
            out["scene_msg"] = f"Scene opened: {scene_path} (Edit Mode, loaded fresh from disk)"
        return p, p.get("role", ""), out

    return await asyncio.gather(*[confirm(p) for p in targets])

async def _stop_play_mode(root: Path, project_root: str, timeout_seconds: int = 30,
                          poll_interval: float = 1.0, focus: bool = True) -> str | None:
    """Stop Play Mode and return None on success, or error string on failure.

    `focus=False` skips the focus-stealing (managed/headless editors — orchestrator primary +
    multiplayer clones — have no window to raise and shouldn't be fought over).
    """
    tick = (lambda: _focus_unity(project_root)) if focus else None
    if focus:
        _focus_unity(project_root)

    enq = await enqueue_retry(root, "stop", {"gen": int(time.time())})
    if enq["error"]:
        return f"ERROR stopping Play Mode: {enq['error']}"

    outcome = await await_command(root, enq["cmdId"], kind="stop",
                                  timeout_seconds=timeout_seconds, on_tick=tick)
    if outcome.kind == DONE:
        return None
    if outcome.kind == ERROR:
        return f"ERROR stopping Play Mode: {outcome.detail}"
    if outcome.kind == EDITOR_DIED:
        return f"ERROR stopping Play Mode: the editor exited. {outcome.detail}"
    if outcome.kind == UNAVAILABLE:
        return f"ERROR: Play Mode wasn't stopped. {outcome.detail}"
    if outcome.kind == DIALOG_BLOCKED:
        return f"BLOCKED BY DIALOG: could not stop Play Mode.\n{outcome.detail}"
    return f"TIMEOUT: Could not stop Play Mode. {outcome.detail}"

def _stop_delivery_evidence(player_dir: str) -> str:
    """Explain a stop-play timeout for one player: was a stop command delivered to its queue, and if so
    did the editor consume/acknowledge it. Read-only over the player's .sspace channel files.

    ``commands.json`` is PRUNED, so an absent stop is not proof one was never sent: the orchestrator
    drops every entry with ``id <= ackedCursor`` when it appends the next command, and the editor
    advances ``ackedCursor`` the moment it BEGINS a command. A delivered stop therefore disappears from
    the queue as soon as anything else is enqueued for that player. Only an EMPTY channel (no commands,
    no acks) proves nothing ever arrived; otherwise absence is inconclusive and we say so rather than
    blaming the orchestrator."""
    root = Path(player_dir)
    try:
        raw = json.loads((root / ".sspace" / "commands.json").read_text(encoding="utf-8"))
        commands = raw.get("commands") or []
        readable = True
    except (OSError, ValueError, AttributeError):
        commands = []
        readable = False

    acks = read_acks(root)
    cursor = acks["ackedCursor"]

    stops = [c for c in commands if isinstance(c, dict) and c.get("kind") == "stop"]
    if not stops:
        if not readable:
            return (
                "still playing — this player's command queue is missing or corrupt, so delivery cannot be "
                "confirmed either way (check unity.logs(), then retry unity.stop())"
            )
        if cursor <= 0 and not acks["acks"]:
            return (
                "still playing — no command has ever reached this player's queue "
                "(the stop intent was lost upstream; retry unity.stop())"
            )
        return (
            f"still playing — no stop is pending in this player's queue (acked through #{cursor}). A stop "
            "is pruned from the queue once the editor consumes it, so one was likely delivered and ran "
            "without leaving Play Mode (check unity.logs(), or unity.relaunch() to start the group over)"
        )

    stop_id = max(int(c.get("id") or 0) for c in stops)
    ack = ack_for(root, stop_id)
    if ack:
        status = ack.get("status") or "?"
        detail = f": {ack['error']}" if ack.get("error") else ""
        return (
            f"still playing — stop #{stop_id} was acknowledged '{status}'{detail} yet the editor "
            "still reports Play Mode (retry unity.stop())"
        )
    if cursor >= stop_id:
        return (
            f"still playing — stop #{stop_id} was consumed but never acknowledged "
            "(the editor is likely wedged mid-stop; check unity.logs(), or unity.relaunch() to start the group over)"
        )
    return (
        f"still playing — stop #{stop_id} is queued but the editor has not consumed it "
        "(command pump stalled; check unity.logs(), or unity.relaunch() to start the group over)"
    )

def _dialog_blocked_line(pdir: Path, dialogs: list[dict]) -> str:
    return "BLOCKED BY DIALOG:\n" + modal_status.dialog_block(pdir, dialogs)

async def _confirmed_dialogs(pdir: Path, recheck_delay: float = 0.3) -> list[dict]:
    """Dialogs actually BLOCKING ``pdir`` (sighted while the editor loop heartbeat is stalled —
    benign popups on a revealed editor don't count), confirmed by a second read after a short
    delay so a self-resolving flash doesn't fail an operation."""
    dialogs = await asyncio.to_thread(modal_status.blocking_dialogs, pdir)
    if not dialogs:
        return []
    await asyncio.sleep(recheck_delay)
    return await asyncio.to_thread(modal_status.blocking_dialogs, pdir)

_CLONE_SYNC_BUDGET = 120.0

def _world_instance(dir_path: str) -> dict:
    """The single instance object from an editor's own .sspace/world.json ({} if unreadable)."""
    try:
        data = json.loads((Path(dir_path) / ".sspace" / "world.json").read_text(encoding="utf-8"))
        insts = (data.get("world") or {}).get("instances") or {}
        for v in insts.values():
            if isinstance(v, dict):
                return v
    except (OSError, json.JSONDecodeError, ValueError, TypeError):
        pass
    return {}

async def _await_clone_asset_sync(root: Path, budget: float) -> str:
    """After a routed refresh, wait for the reload fan-out to finish on every clone.

    The reconciler reloads each clone once the primary settles — shared-assembly reload plus
    AssetDatabase.Refresh(ForceUpdate), mirroring Unity MPPM's own clone sync, which is what makes
    assets added while a clone runs loadable in it. Returns once every clone's refreshGen has
    caught the primary's, so callers can trust the whole group sees the refreshed assets; WARNING
    on timeout."""
    players = await asyncio.to_thread(discover_players, str(root))
    if not any(p["role"] == "clone" for p in players):
        return ""
    deadline = time.monotonic() + budget
    while time.monotonic() < deadline:
        players = await asyncio.to_thread(discover_players, str(root))
        primary = next((p for p in players if p["role"] == "primary"), None)
        clones = [p for p in players if p["role"] == "clone"]
        if primary is not None:
            pgen = int(_world_instance(primary["dir"]).get("refreshGen") or 0)
            if all(int(_world_instance(c["dir"]).get("refreshGen") or 0) >= pgen for c in clones):
                return ""
        await asyncio.sleep(1.0)
    who = f"unity.at('{root}')" if scratchpad_id(str(root)) else "unity"
    return (
        f"\nWARNING: clone(s) did not finish their post-refresh reload within {int(budget)}s — "
        "refreshed assets may not be loadable in those players yet. Check unity.status(); "
        f"as a last resort, remove those clones and add them back with {who}.removePlayer() and {who}.addPlayer() for a clean import."
    )

async def _run_recompile(
    root: Path,
    project_root: str,
    routed: bool,
    timeout_seconds: float,
    *,
    focus: bool = True,
) -> tuple[str | None, OpOutcome | None]:
    started = time.monotonic()
    enq = await enqueue_retry(root, "recompile", {"gen": int(time.time())}, retry_seconds=max(45.0, timeout_seconds - 15.0))
    if enq.get("unavailable"):
        return None, OpOutcome(UNAVAILABLE, detail=enq["error"])
    if enq["error"]:
        return enq["error"], None
    do_focus = focus and not routed
    if do_focus:
        _focus_unity(project_root)
    outcome = await await_command(
        root, enq["cmdId"], kind="recompile",
        timeout_seconds=max(15.0, timeout_seconds - (time.monotonic() - started)),
        on_tick=(lambda: _focus_unity(project_root)) if do_focus else None,
    )
    return None, outcome

_PRE_SCENE_REFRESH_TIMEOUT = 300.0

async def _refresh_before_scene(
    root: Path,
    project_root: str,
    routed: bool,
    *,
    focus: bool,
    play: bool = False,
) -> tuple[str | None, str]:
    """Make sure the editor has imported + compiled the latest on-disk edits before a scene load.

    Runs inside unity.openScene()'s project_editor_lock — never acquires it. Skips when the editor
    is playing (refresh is refused in Play Mode) or down (open_scene surfaces its own error);
    when a compile is already in flight it waits for the editor to settle instead of stacking a
    second refresh. Returns (fatal_error, warning_note)."""
    if _check_is_playing(root):
        return None, ""
    if instances.editor_health(str(root)).get("state") == "DOWN":
        return None, ""

    if _check_is_compiling(root):
        do_focus = focus and not routed
        ready, reason = await await_editor_ready(
            root,
            timeout_seconds=_PRE_SCENE_REFRESH_TIMEOUT,
            poll_interval=1.0,
            on_tick=(lambda: _focus_unity(project_root)) if do_focus else None,
        )
        if ready:
            return None, ""
        if reason.startswith(DIALOG_REASON_PREFIX):
            return (
                f"BLOCKED BY DIALOG: the editor cannot settle before opening the scene.\n{reason}\n"
                "Scene not opened."
            ), ""
        if reason.startswith(EARLY_PREFIX):
            return f"ERROR: the scene wasn't opened. {reason[len(EARLY_PREFIX):]}", ""
        return (
            f"TIMEOUT: Unity was already compiling and did not settle within "
            f"{int(_PRE_SCENE_REFRESH_TIMEOUT)}s before opening the scene ({reason}).\n"
            "Scene not opened — check unity.status(), or pass refresh: false to skip the refresh."
        ), ""

    enq_err, outcome = await _run_recompile(
        root, project_root, routed, _PRE_SCENE_REFRESH_TIMEOUT, focus=focus,
    )
    if enq_err:
        return f"ERROR: could not enqueue the refresh before opening the scene: {enq_err}", ""
    if outcome.kind == DONE:
        note = await _await_clone_asset_sync(root, _CLONE_SYNC_BUDGET) if routed else ""
        return None, note
    if outcome.kind == ERROR:
        if play:
            return (
                f"ERROR: the project has COMPILE ERRORS, so Unity can't enter Play Mode:\n{outcome.detail}\n"
                "Fix them, then call unity.play() again."
            ), ""
        return (
            f"ERROR: the refresh before opening the scene failed — COMPILE ERRORS:\n{outcome.detail}\n"
            "Scene not opened. Fix the errors and retry (or pass refresh: false to open it against the last good build)."
        ), ""
    if outcome.kind == UNAVAILABLE:
        return f"ERROR: the scene wasn't opened. {outcome.detail}", ""
    if outcome.kind == EDITOR_DIED:
        return (
            f"ERROR: the refresh before opening the scene aborted — the Unity editor exited during refresh.\n"
            f"{outcome.detail}\nCheck unity.logs({{ source: 'editor' }})."
        ), ""
    if outcome.kind == DIALOG_BLOCKED:
        return (
            f"BLOCKED BY DIALOG: the refresh before opening the scene cannot proceed.\n{outcome.detail}\n"
            "Scene not opened."
        ), ""
    return (
        f"TIMEOUT: the refresh before opening the scene did not complete: {outcome.detail}\n"
        "Scene not opened — retry, or pass refresh: false to skip the refresh."
    ), ""

@tool_guard
async def unity_refresh(
    timeout_seconds: Annotated[int, Field(description="Most seconds to wait while Unity makes progress, at most 900. The wait ends early, with the reason, when Unity stops or shows no progress for 30 s.")] = 300,
    project_root: ProjectRoot = "",
) -> str:
    project_root = resolve_root(project_root)
    root = Path(project_root)
    if not (root / "Assets").is_dir():
        return f"ERROR: Not a Unity project: {root}"

    panel = require_player_panel(str(root))
    if panel:
        return panel

    down = await unavailable_message(root)
    if down:
        return f"ERROR: {down}"

    if _check_is_playing(root):
        return (
            "Unity is in Play Mode — refresh is not possible (it would exit Play Mode and tear down the "
            "live session). If hot reload is armed, just edit + save your .cs files; changes are "
            "live-patched into the running player, no refresh needed. To force a full recompile, stop "
            f"Play Mode first.\n\n{players_summary(project_root)}"
        )

    dialogs = await _confirmed_dialogs(root)
    if dialogs:
        return (
            f"BLOCKED BY DIALOG: the refresh cannot proceed.\n"
            f"{modal_status.dialog_block(root, dialogs)}\n\n"
            f"{players_summary(project_root)}"
        )

    routed = await orchestrator_drives(str(root))
    async with project_editor_lock(root, timeout_seconds, op="refresh") as acquired:
        if not acquired:
            return _editor_busy_message(root, "refresh", timeout_seconds)

        if not routed:
            if instances.editor_health(str(root)).get("state") == "DOWN":
                return (
                    "No Unity editor is open for this project — nothing to refresh.\n"
                    "Open the project in Unity Editor (or start the orchestrator) first, then refresh.\n\n"
                    f"{players_summary(project_root)}"
                )
            if _check_is_compiling(root):
                return "Unity is already compiling. Wait for it to finish."

        pre_stamp = _clean_compile_stamp(root)
        enq_err, outcome = await _run_recompile(root, project_root, routed, timeout_seconds)
        if enq_err:
            return (
                f"ERROR: could not enqueue refresh: {enq_err}\n\n"
                f"{players_summary(project_root)}"
            )

    if outcome.kind == DONE:
        post_stamp = _clean_compile_stamp(root)
        if post_stamp is not None and post_stamp != pre_stamp:
            headline = "Refresh completed — scripts recompiled. No compile errors."
        elif pre_stamp is not None:
            headline = "Refresh completed — no script changes, nothing to recompile. No compile errors."
        else:
            headline = "Refresh completed. No compile errors."
        sync_note = await _await_clone_asset_sync(root, _CLONE_SYNC_BUDGET) if routed else ""
        return f"{headline}{sync_note}\n\n{players_summary(project_root)}"
    if outcome.kind == ERROR:
        return (
            f"Refresh completed but there were COMPILE ERRORS.\n{outcome.detail}\n\n"
            f"{players_summary(project_root)}"
        )
    if outcome.kind == UNAVAILABLE:
        return f"ERROR: {outcome.detail}"
    if outcome.kind == EDITOR_DIED:
        return (
            f"REFRESH ABORTED: the Unity editor exited during refresh.\n{outcome.detail}\n"
            "Usually a crash on recompile — check unity.logs({ source: 'editor' }).\n\n"
            f"{players_summary(project_root)}"
        )
    if outcome.kind == DIALOG_BLOCKED:
        return (
            f"BLOCKED BY DIALOG: the refresh cannot proceed.\n{outcome.detail}\n\n"
            f"{players_summary(project_root)}"
        )
    if (outcome.data or {}).get("noProgress"):
        return f"TIMEOUT: {outcome.detail}"
    return (
        f"TIMEOUT: {outcome.detail}\n"
        "Check that Unity Editor is open with this project.\n"
        "Common causes: compilation is stuck or a dialog is blocking.\n\n"
        f"{players_summary(project_root)}"
    )

@tool_guard
async def unity_stop_play(
    timeout_seconds: Annotated[int, Field(description="Seconds to wait per player.")] = 30,
    poll_interval: Annotated[float, Field(description="Seconds between status checks. Rarely needed.")] = 0.25,
    project_root: ProjectRoot = "",
) -> str:
    project_root = resolve_root(project_root)
    root = Path(project_root)
    if not (root / "Assets").is_dir():
        return f"ERROR: Not a Unity project: {root}"

    panel = require_player_panel(str(root))
    if panel:
        return panel

    players = discover_players(str(root))
    if not players:
        return "No editor running — nothing to stop (already in Edit Mode)."
    targets = players

    count = len(players)

    blocked_upfront = []
    for p in players:
        dialogs = await _confirmed_dialogs(Path(p["dir"]))
        if dialogs:
            blocked_upfront.append((p, dialogs))
    if len(blocked_upfront) == len(players):
        if len(blocked_upfront) == 1:
            p, dialogs = blocked_upfront[0]
            return _dialog_blocked_line(Path(p["dir"]), dialogs)
        lines = [f"Stop Play across {len(players)} player(s):"]
        for p, dialogs in blocked_upfront:
            lines.append(f"  {player_label(p)}  {_dialog_blocked_line(Path(p['dir']), dialogs)}")
        return "\n".join(lines)

    idle = 0
    for p in players:
        health = await asyncio.to_thread(instances.editor_health, p["dir"])
        if health.get("state") == "RUNNING" and not health.get("isPlaying"):
            idle += 1
    if idle == len(players):
        if idle == 1:
            return "Already in Edit Mode — nothing to stop."
        return f"Already in Edit Mode on all {idle} player(s) — nothing to stop."

    async with project_editor_lock(root, timeout_seconds, op="stopplay") as acquired:
        if not acquired:
            return _editor_busy_message(root, "stopplay", timeout_seconds)

        if await orchestrator_drives(str(root)):
            cmd = await request_player_command(str(root), "stop")
            if not cmd.get("ok"):
                return (
                    f"ERROR (orchestrator stop): {cmd.get('error', 'unknown')}\n"
                    "Satura Space is managing this project but didn't apply the stop. "
                    "Make sure the Unity Player panel is open, then retry."
                )
            deadline = time.monotonic() + timeout_seconds

            async def _confirm_stop(p: dict):
                pdir = Path(p["dir"])
                health = {}
                while time.monotonic() < deadline:
                    dialogs = await _confirmed_dialogs(pdir)
                    if dialogs:
                        return p, _dialog_blocked_line(pdir, dialogs)
                    health = await asyncio.to_thread(instances.editor_health, p["dir"])
                    if health.get("state") == "RUNNING" and not health.get("isPlaying"):
                        return p, None
                    await asyncio.sleep(poll_interval)
                if health.get("state") != "RUNNING" and not health.get("isPlaying"):
                    return p, (
                        "stop unconfirmed — this editor's heartbeat is stale "
                        f"(state {health.get('state', '?')}), so its reported Edit Mode cannot be "
                        "trusted; it may be compiling, mid domain reload, or frozen "
                        "(check unity.status() / unity.logs(), then retry unity.stop())"
                    )
                return p, await asyncio.to_thread(_stop_delivery_evidence, p["dir"])

            results = await asyncio.gather(*[_confirm_stop(p) for p in targets])
            if len(results) == 1:
                return "Play Mode stopped (now in Edit Mode)." if results[0][1] is None else results[0][1]
            lines = [f"Stop Play across {len(results)} player(s):"]
            for p, r in results:
                lines.append(f"  {player_label(p)}  {'OK' if r is None else r}")
            return "\n".join(lines)

        focus = count == 1 and players[0].get("isBatchMode") is False

        async def _stop(p: dict):
            r = await _stop_play_mode(Path(p["dir"]), p["dir"], timeout_seconds, poll_interval, focus=focus)
            return p, r

        results = await asyncio.gather(*[_stop(p) for p in targets])

        if len(results) == 1:
            r = results[0][1]
            return r if r is not None else "Play Mode stopped (now in Edit Mode)."
        lines = [f"Stop Play across {len(results)} player(s):"]
        for p, r in results:
            lines.append(f"  {player_label(p)}  {'OK' if r is None else r}")
        return "\n".join(lines)


_exec_seq = itertools.count()

def _editor_busy_message(root: Path, op: str, timeout_seconds: float) -> str:
    dead = stale_holder(root)
    if dead is not None:
        return (
            f"BUSY: the editor-op lock is held by a holder that is no longer alive "
            f"(pid {dead.get('pid')}, op '{dead.get('op')}'). The OS should have released it; if this "
            f"'{op}' keeps failing, the editor may be wedged — check unity.status() / unity.logs() "
            "and relaunch if needed."
        )
    return (
        f"BUSY: another editor operation is already running in this editor and did not finish in "
        f"{timeout_seconds:.0f}s.\n"
        "unity.exec, refresh, openScene, play and stop run one at a time per project, because they share one "
        "editor. Await each call before starting the next, or pass a bigger timeout to wait for the editor."
    )

_EXEC_DIRTY_MARKER = "__MCP_SCENE_DIRTY__:"
_EXEC_SAVED_MARKER = "__MCP_SAVED__:"

_EXEC_TEMPLATE = '''\
using UnityEngine;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine.SceneManagement;
using static UnityEngine.Object;
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using SaturaSpace;
{extra_usings}
static class _MCPExec_{uid}
{{
    static readonly StringBuilder _sb = new();
    static void Print(object v) => _sb.AppendLine(v?.ToString() ?? "null");
    static long SameMoment(double seconds) => {group_ms}L + (long)(seconds * 1000.0);

    static string PathOf(UnityEngine.Object _o)
    {{
        var _go = _o as GameObject ?? (_o as Component)?.gameObject;
        if (_go == null) return _o == null ? "null" : _o.name;
        var _p = _PathSeg(_go.transform);
        for (var _t = _go.transform.parent; _t != null; _t = _t.parent) _p = _PathSeg(_t) + "/" + _p;
        return _p;
    }}

    static string _PathSeg(Transform _t)
    {{
        int _k = 0, _c = 0;
        if (_t.parent != null)
        {{
            for (int _i = 0; _i < _t.parent.childCount; _i++)
            {{
                var _s = _t.parent.GetChild(_i);
                if (_s.name == _t.name && ++_c > 0 && _s == _t) _k = _c;
            }}
        }}
        else if (_t.gameObject.scene.IsValid())
        {{
            foreach (var _r in _t.gameObject.scene.GetRootGameObjects())
                if (_r.name == _t.name && ++_c > 0 && _r.transform == _t) _k = _c;
        }}
        return _k <= 1 ? _t.name : _t.name + "[" + _k + "]";
    }}

    static void UserFeedback(Vector3 _camPos, Vector3 _lookAt)
    {{
        Type _fb = null;
        foreach (var _asm in AppDomain.CurrentDomain.GetAssemblies())
        {{
            try {{ _fb = _asm.GetType("SaturaSpace.AgentFeedback"); }} catch {{ continue; }}
            if (_fb != null) break;
        }}
        var _m = _fb?.GetMethod("UserFeedback", new[] {{ typeof(Vector3), typeof(Vector3) }});
        if (_m == null) {{ Print("[feedback] AgentFeedback unavailable in this engine build - skipped"); return; }}
        var _msg = (string)_m.Invoke(null, new object[] {{ _camPos, _lookAt }});
        if (_msg != null) Print(_msg);
    }}

    static void RunDeferred(Action _a)
    {{
        if (_a == null) return;
        var _rd = typeof(MCPTestBridge).GetMethod("RunDeferred", new[] {{ typeof(Action) }});
        if (_rd != null) {{ _rd.Invoke(null, new object[] {{ _a }}); return; }}
        EditorApplication.delayCall += () => _a();
        Print("[deferred] engine lacks MCPTestBridge.RunDeferred — fell back to EditorApplication.delayCall; this older engine does not pump starved delayCalls, so the action may never run while the editor is unfocused");
    }}

    static int _GameObjectState(GameObject _g)
    {{
        int _n = StringComparer.Ordinal.GetHashCode(_g.name);
        _n = unchecked(_n * 31 + (_g.activeSelf ? 1 : 2) + 7 * _g.layer);
        try {{ _n = unchecked(_n * 31 + StringComparer.Ordinal.GetHashCode(_g.tag)); }} catch {{}}
        return unchecked(_n * 31 + (int)GameObjectUtility.GetStaticEditorFlags(_g) + 3 * (int)_g.hideFlags);
    }}

    static int _SceneFingerprint(UnityEngine.SceneManagement.Scene _s)
    {{
        int _n = 17;
        foreach (var _r in _s.GetRootGameObjects())
            foreach (var _c in _r.GetComponentsInChildren<Component>(true))
            {{
                _n = unchecked(_n * 31 + (_c == null ? 7 : _c.GetHashCode() + 89 * EditorUtility.GetDirtyCount(_c)));
                var _tf = _c as Transform;
                if (_tf != null)
                    _n = unchecked(_n * 31 + _tf.localPosition.GetHashCode()
                        + 131 * _tf.localRotation.GetHashCode()
                        + 17 * _tf.localScale.GetHashCode()
                        + 23 * _GameObjectState(_tf.gameObject));
                else if (_c is MonoBehaviour)
                {{
                    try {{ _n = unchecked(_n * 31 + StringComparer.Ordinal.GetHashCode(EditorJsonUtility.ToJson(_c))); }}
                    catch {{ _n = unchecked(_n * 31 + 5); }}
                }}
            }}
        return _n;
    }}

    static long _SceneFileTicks(UnityEngine.SceneManagement.Scene _s)
    {{
        try
        {{
            if (!string.IsNullOrEmpty(_s.path) && File.Exists(_s.path))
                return File.GetLastWriteTimeUtc(_s.path).Ticks;
        }}
        catch {{}}
        return 0;
    }}

    static readonly HashSet<UnityEngine.SceneManagement.Scene> _userDirtied =
        new HashSet<UnityEngine.SceneManagement.Scene>();
    static bool _userDirtiedAll;
    static readonly HashSet<UnityEngine.SceneManagement.Scene> _savedSinceMarkAll =
        new HashSet<UnityEngine.SceneManagement.Scene>();
    static bool _selfMark;
    static readonly SortedDictionary<string, byte[]> _savedPaths = new SortedDictionary<string, byte[]>(StringComparer.Ordinal);
    static byte[] _ReadSaved(string p) {{ try {{ return File.Exists(p) ? File.ReadAllBytes(p) : null; }} catch {{ return null; }} }}
    static bool _SavedChanged(string p, byte[] before) {{ var now = _ReadSaved(p); if (before == null || now == null) return before != now; return !before.SequenceEqual(now); }}
    static bool _dirtyIntentTracked;
    static object _dirtyIntentHarmony;

    static readonly Dictionary<UnityEngine.SceneManagement.Scene, int> _pre =
        new Dictionary<UnityEngine.SceneManagement.Scene, int>();
    static readonly Dictionary<UnityEngine.SceneManagement.Scene, long> _preTicks =
        new Dictionary<UnityEngine.SceneManagement.Scene, long>();
    static readonly HashSet<UnityEngine.SceneManagement.Scene> _savedDuring =
        new HashSet<UnityEngine.SceneManagement.Scene>();
    static readonly Dictionary<UnityEngine.SceneManagement.Scene, int> _savedFp =
        new Dictionary<UnityEngine.SceneManagement.Scene, int>();
    static readonly HashSet<UnityEngine.SceneManagement.Scene> _weMarked =
        new HashSet<UnityEngine.SceneManagement.Scene>();

    static bool SceneActuallyDirty(UnityEngine.SceneManagement.Scene _s)
    {{
        if ((_userDirtiedAll && !_savedSinceMarkAll.Contains(_s)) || _userDirtied.Contains(_s)) return true;
        int _ref;
        if (_savedFp.TryGetValue(_s, out _ref)) return _SceneFingerprint(_s) != _ref;
        if (_weMarked.Contains(_s) && _pre.TryGetValue(_s, out _ref)) return _SceneFingerprint(_s) != _ref;
        return _s.isDirty;
    }}

    public static void _MarkDirtyPrefix(UnityEngine.SceneManagement.Scene __0)
    {{
        if (!_selfMark) {{ _userDirtied.Add(__0); _savedSinceMarkAll.Remove(__0); }}
    }}

    public static void _MarkAllDirtyPrefix()
    {{
        if (!_selfMark) {{ _userDirtiedAll = true; _savedSinceMarkAll.Clear(); }}
    }}

    static readonly List<UnityEngine.SceneManagement.Scene> _hiddenMarks =
        new List<UnityEngine.SceneManagement.Scene>();
    static int _promptDepth;
    static System.Reflection.MethodInfo _clearDirtinessMethod;

    public static void _HideOwnMarksPrefix()
    {{
        if (_promptDepth++ > 0 || _clearDirtinessMethod == null) return;
        foreach (var _s in _weMarked)
        {{
            try
            {{
                int _ref;
                if (!_s.IsValid() || !_s.isLoaded || !_s.isDirty) continue;
                if ((_userDirtiedAll && !_savedSinceMarkAll.Contains(_s)) || _userDirtied.Contains(_s)) continue;
                if (_savedFp.ContainsKey(_s) || !_pre.TryGetValue(_s, out _ref) || _SceneFingerprint(_s) != _ref) continue;
                _clearDirtinessMethod.Invoke(null, new object[] {{ _s }});
                if (!_s.isDirty) _hiddenMarks.Add(_s);
            }}
            catch {{}}
        }}
    }}

    public static void _HideOwnMarksFinalizer()
    {{
        if (--_promptDepth > 0) return;
        foreach (var _s in _hiddenMarks)
        {{
            try
            {{
                if (!_s.IsValid() || !_s.isLoaded || _s.isDirty) continue;
                _selfMark = true;
                try {{ EditorSceneManager.MarkSceneDirty(_s); }}
                finally {{ _selfMark = false; }}
            }}
            catch {{}}
        }}
        _hiddenMarks.Clear();
    }}

    static void _PatchDirtyIntent()
    {{
        try
        {{
            var _mk = typeof(EditorSceneManager).GetMethod("MarkSceneDirty",
                System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static,
                null, new[] {{ typeof(UnityEngine.SceneManagement.Scene) }}, null);
            var _mkAll = typeof(EditorSceneManager).GetMethod("MarkAllScenesDirty",
                System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static,
                null, Type.EmptyTypes, null);
            if (_mk == null || _mk.GetMethodBody() == null) return;
            var _h = new HotReloadPrototype.Editor.ExecHarmony("satura.exec.{uid}");
            _h.Patch(_mk, prefix: typeof(_MCPExec_{uid}).GetMethod("_MarkDirtyPrefix"));
            _dirtyIntentHarmony = _h;
            _dirtyIntentTracked = true;
            if (_mkAll != null && _mkAll.GetMethodBody() != null)
                _h.Patch(_mkAll, prefix: typeof(_MCPExec_{uid}).GetMethod("_MarkAllDirtyPrefix"));
            _clearDirtinessMethod = typeof(EditorSceneManager).GetMethod("ClearSceneDirtiness",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static,
                null, new[] {{ typeof(UnityEngine.SceneManagement.Scene) }}, null);
            if (_clearDirtinessMethod != null)
                foreach (var _pm in typeof(EditorSceneManager).GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static))
                {{
                    if (_pm.Name != "SaveCurrentModifiedScenesIfUserWantsTo" && _pm.Name != "SaveModifiedScenesIfUserWantsTo") continue;
                    if (_pm.GetMethodBody() == null) continue;
                    try
                    {{
                        _h.Patch(_pm,
                            prefix: typeof(_MCPExec_{uid}).GetMethod("_HideOwnMarksPrefix"),
                            finalizer: typeof(_MCPExec_{uid}).GetMethod("_HideOwnMarksFinalizer"));
                    }}
                    catch {{}}
                }}
        }}
        catch {{ _dirtyIntentTracked = false; }}
    }}

    static void _UnpatchDirtyIntent()
    {{
        try
        {{
            var _h = _dirtyIntentHarmony as HotReloadPrototype.Editor.ExecHarmony;
            _dirtyIntentHarmony = null;
            if (_h != null) _h.UnpatchAll();
        }}
        catch {{}}
    }}

    public static void Run()
    {{
        var _result = new MCPTestBridge.ExecResultData();
        var _saveSink = typeof(MCPTestBridge).GetField("ExecSavingAssets", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
        try {{ _saveSink?.SetValue(null, (Action<string[]>)(_ps => {{ if (_ps != null) foreach (var _p in _ps) if (!string.IsNullOrEmpty(_p) && !_savedPaths.ContainsKey(_p)) _savedPaths[_p] = _ReadSaved(_p); }})); }}
        catch {{ _saveSink = null; }}
        bool _editMode = !EditorApplication.isPlaying;
        bool _track = _editMode && !{read_only};
        EditorSceneManager.SceneSavedCallback _onSaved =
            _saved => {{ _savedDuring.Add(_saved); _savedFp[_saved] = _SceneFingerprint(_saved); _userDirtied.Remove(_saved); if (_userDirtiedAll) _savedSinceMarkAll.Add(_saved); }};
        EditorSceneManager.SceneSavingCallback _onSaving = (_saving, _savingPath) => Undo.FlushUndoRecordObjects();
        Action<UnityEngine.SceneManagement.Scene> _trackScene = _o =>
        {{
            try
            {{
                if (!_o.isLoaded) return;
                if (!_o.isDirty && !string.IsNullOrEmpty(_o.path) && File.Exists(_o.path))
                {{
                    _selfMark = true;
                    try {{ EditorSceneManager.MarkSceneDirty(_o); }}
                    finally {{ _selfMark = false; }}
                    _weMarked.Add(_o);
                }}
                _pre[_o] = _SceneFingerprint(_o);
                _preTicks[_o] = _SceneFileTicks(_o);
            }}
            catch {{}}
        }};
        EditorSceneManager.SceneOpenedCallback _onOpened = (_o, _m) => _trackScene(_o);
        EditorSceneManager.NewSceneCreatedCallback _onCreated = (_o, _st, _m) => _trackScene(_o);
        if (_track)
        {{
            try
            {{
                EditorSceneManager.sceneSaving += _onSaving;
                EditorSceneManager.sceneSaved += _onSaved;
                EditorSceneManager.sceneOpened += _onOpened;
                EditorSceneManager.newSceneCreated += _onCreated;
                for (int _i = 0; _i < EditorSceneManager.sceneCount; _i++)
                    _trackScene(EditorSceneManager.GetSceneAt(_i));
                _PatchDirtyIntent();
                var _dp = typeof(MCPTestBridge).GetField("ExecSceneDirty", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
                if (_dp != null) _dp.SetValue(null, (Func<UnityEngine.SceneManagement.Scene, bool>)SceneActuallyDirty);
            }}
            catch {{}}
        }}
        try
        {{
#line 1 "unity.exec"
{code}
#line default
            _result.status = "completed";
        }}
        catch (Exception _ex)
        {{
            _result.status = "error";
            _result.error = (_ex.GetType().Name == "SaturaClipException" ? "SaturaClipException: " + _ex.Message : _ex.ToString())
                + "\\n\\n[note] The exception was thrown mid-run; any asset/scene/prefab changes made "
                + "before it are NOT rolled back and may be left partially applied. Re-run a query to "
                + "check current state before retrying.";
        }}
        if (_editMode && !_track)
        {{
            var _dirtyNow = new List<string>();
            for (int _i = 0; _i < EditorSceneManager.sceneCount; _i++)
            {{
                var _s = EditorSceneManager.GetSceneAt(_i);
                if (_s.isDirty) _dirtyNow.Add(string.IsNullOrEmpty(_s.path) ? _s.name : _s.path);
            }}
            if (_dirtyNow.Count > 0) _sb.AppendLine("{dirty_marker}" + string.Join(", ", _dirtyNow));
        }}
        if (_track)
        {{
            _UnpatchDirtyIntent();
            try {{ typeof(MCPTestBridge).GetField("ExecSceneDirty", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)?.SetValue(null, null); }}
            catch {{}}
            try
            {{
                EditorSceneManager.sceneSaving -= _onSaving;
                EditorSceneManager.sceneSaved -= _onSaved;
                EditorSceneManager.sceneOpened -= _onOpened;
                EditorSceneManager.newSceneCreated -= _onCreated;
                var _clearDirtiness = typeof(EditorSceneManager).GetMethod("ClearSceneDirtiness",
                    System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
                var _dirty = new List<string>();
                for (int _i = 0; _i < EditorSceneManager.sceneCount; _i++)
                {{
                    var _s = EditorSceneManager.GetSceneAt(_i);
                    long _t0;
                    bool _savedOnDisk = _savedDuring.Contains(_s)
                        || (_preTicks.TryGetValue(_s, out _t0) && _SceneFileTicks(_s) > _t0);
                    if (_s.isLoaded)
                    {{
                        int _fpNow = _SceneFingerprint(_s);
                        int _fpRef;
                        bool _userIntent = (_userDirtiedAll && !_savedSinceMarkAll.Contains(_s)) || _userDirtied.Contains(_s);
                        if (_savedOnDisk)
                        {{
                            if (_savedFp.TryGetValue(_s, out _fpRef) && _fpRef != _fpNow && !_s.isDirty)
                                EditorSceneManager.MarkSceneDirty(_s);
                        }}
                        else if (_pre.TryGetValue(_s, out _fpRef))
                        {{
                            if (_fpRef != _fpNow)
                            {{
                                if (!_s.isDirty) EditorSceneManager.MarkSceneDirty(_s);
                            }}
                            else if (_userIntent)
                                _sb.AppendLine("[dirty] " + (string.IsNullOrEmpty(_s.path) ? _s.name : _s.path)
                                    + ": marked dirty by your code - the change itself is not detectable"
                                    + " by the tool and is UNSAVED until the user"
                                    + " saves it.");
                            else if (_weMarked.Contains(_s) && _s.isDirty
                                && _dirtyIntentTracked && _clearDirtiness != null)
                                _clearDirtiness.Invoke(null, new object[] {{ _s }});
                        }}
                    }}
                    if (_s.isDirty) _dirty.Add(string.IsNullOrEmpty(_s.path) ? _s.name : _s.path);
                }}
                if (_dirty.Count > 0) _sb.AppendLine("{dirty_marker}" + string.Join(", ", _dirty));
            }}
            catch {{}}
        }}
        try {{ _saveSink?.SetValue(null, null); }}
        catch {{}}
        var _written = _savedPaths.Where(_kv => _SavedChanged(_kv.Key, _kv.Value)).Select(_kv => _kv.Key).ToList();
        if (_written.Count > 0) _sb.AppendLine("{saved_marker}" + string.Join("|", _written));
        _result.output = _sb.ToString();
        _result.nonce = "{uid}";
        _result.timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        File.WriteAllText(@"{results_path}", JsonUtility.ToJson(_result, true));
        MCPTestBridge.NotifyExecDone("{uid}", _result.status);
    }}
}}
'''

_USING_DIRECTIVE = re.compile(r"^\s*using\s+((?:static\s+)?[A-Za-z_][\w.]*(?:\s*=\s*[\w.<>, ]+)?)\s*;\s*$")


def _hoist_usings(code: str) -> tuple[str, list[str]]:
    lines = code.split("\n")
    hoisted = []
    for i, line in enumerate(lines):
        m = _USING_DIRECTIVE.match(line)
        if m:
            hoisted.append(m.group(1))
            lines[i] = ""
        elif line.strip() and not line.strip().startswith("//"):
            break
    return "\n".join(lines), hoisted


async def _unity_exec_each(
    project_root: str,
    code: str,
    timeout_seconds: float = 300,
    extra_usings: str = "",
    target: str = "primary",
    is_query: bool = False,
    code_for=None,
    only: set | None = None,
) -> str | list:
    try:
        timeout_seconds = float(timeout_seconds)
    except (TypeError, ValueError):
        timeout_seconds = 300.0
    project_root = resolve_root(project_root)
    root = Path(project_root)
    if not (root / "Assets").is_dir():
        return f"ERROR: Not a Unity project: {root}"
    if not code.strip() and code_for is None:
        return "ERROR: code is required (C# method-body to execute)."

    err = await _ensure_unity_up(root)
    if err:
        return err

    players = discover_players(project_root)
    sel = select_targets(players, target or "primary") if players else []
    if only is not None:
        sel = [p for p in sel if p["dir"] in only]
    if not sel:
        return (
            f"ERROR: no live player matches player '{target}'.\n"
            f"{players_summary(project_root)}"
        )

    if isinstance(code, str):
        code, hoisted = _hoist_usings(code)
        extra_usings = "\n".join(u for u in [extra_usings, *hoisted] if u)
    usings_block = ""
    if extra_usings:
        for line in extra_usings.replace(";", "\n").splitlines():
            line = line.strip()
            if not line:
                continue
            if not line.startswith("using "):
                line = f"using {line}"
            if not line.endswith(";"):
                line += ";"
            usings_block += line + "\n"

    uid = f"{int(time.time() * 1000):x}{next(_exec_seq):x}"
    script_name = f"_MCPExec_{uid}.cs"
    focus_primary = not orchestrator_present(str(root))

    results = []
    group_ms = int(time.time() * 1000)
    async with project_editor_lock(root, timeout_seconds, op="exec") as acquired:
        if not acquired:
            return _editor_busy_message(root, "exec", timeout_seconds)

        async def one(p):
            tick = None
            if focus_primary and p["role"] == "primary":
                tick = lambda: _focus_unity(project_root)
            return await _exec_on_editor(
                Path(p["dir"]), uid, script_name, code_for(p) if code_for else code, usings_block,
                timeout_seconds, tick, is_query, group_ms,
            )

        texts = await asyncio.gather(*(one(p) for p in sel))
        results = list(zip(sel, texts))

    return results

async def _unity_exec(
    project_root: str,
    code: str,
    timeout_seconds: float = 300,
    extra_usings: str = "",
    target: str = "primary",
    is_query: bool = False,
) -> str:
    out = await _unity_exec_each(project_root, code, timeout_seconds, extra_usings, target, is_query)
    if isinstance(out, str):
        return out
    if len(out) == 1:
        return out[0][1]
    return "\n\n".join(f"{player_label(p)}\n{text}" for p, text in out)

async def _exec_on_editor(
    pdir: Path,
    uid: str,
    script_name: str,
    code: str,
    usings_block: str,
    timeout_seconds: float,
    tick,
    is_query: bool = False,
    group_ms: int = 0,
) -> str:
    """Run one exec on ONE editor rooted at ``pdir`` (the project root for the primary, a
    ``Library/VP/<vpId>`` dir for a clone). Every editor drains its own ``.sspace`` channel and reads
    exec sources from its own ``.sspace/exec``, so writing/enqueuing/awaiting against ``pdir``
    addresses exactly that editor. Runs under the caller's ``project_editor_lock``; multi-target
    callers run it for every editor at once."""
    dialogs = await _confirmed_dialogs(pdir)
    if dialogs:
        return (
            "BLOCKED BY DIALOG: the exec cannot run.\n"
            + modal_status.dialog_block(pdir, dialogs)
        )
    exec_dir = ensure_sspace(pdir) / "exec"
    exec_dir.mkdir(parents=True, exist_ok=True)
    script_path = exec_dir / script_name

    results_file = pdir / ".sspace" / f".mcp_exec_results.{uid}.json"
    results_path_str = str(results_file).replace("\\", "/")

    if isinstance(code, dict):
        script_path = script_path.with_suffix(".json")
        source = json.dumps(code)
    else:
        source = _EXEC_TEMPLATE.format(
            uid=uid,
            group_ms=group_ms or int(time.time() * 1000),
            code=code,
            extra_usings=usings_block if re.search(r"\busing\s+Object\s*=", usings_block) else (usings_block + "\nusing Object = UnityEngine.Object;").lstrip("\n"),
            results_path=results_path_str,
            dirty_marker=_EXEC_DIRTY_MARKER,
            saved_marker=_EXEC_SAVED_MARKER,
            read_only="true" if snippet_is_read_only(code) else "false",
        )

    _sweep_stale_exec_scripts(pdir, exec_dir, keep=script_path.name)
    script_path.write_text(source, encoding="utf-8")

    if results_file.exists():
        results_file.unlink()

    enq = await enqueue(
        pdir, "exec",
        {"nonce": uid, "results": results_path_str, "timeoutSeconds": timeout_seconds},
    )
    if enq["error"]:
        _remove_exec_script(script_path)
        return f"ERROR: could not enqueue exec: {enq['error']}"

    try:
        outcome = await await_command(
            pdir, enq["cmdId"], kind="exec",
            timeout_seconds=timeout_seconds,
            on_tick=tick,
        )
    except asyncio.CancelledError:
        _remove_exec_script(script_path)
        try:
            results_file.unlink()
        except OSError:
            pass
        raise

    result_data = _read_exec_result(results_file, uid)
    if result_data is None and outcome.kind == DIALOG_BLOCKED:
        return (
            f"BLOCKED BY DIALOG: the exec cannot run.\n{outcome.detail}\n"
            "The exec is still pending in the editor — once the dialog is resolved it finishes on its "
            f"own and writes its result (Print output + status) to:\n  {results_file}\n"
            "unity.answer() reports that result automatically after resolving; otherwise read "
            "the file directly. Do NOT re-run the exec — it would run twice."
        )
    _remove_exec_script(script_path)
    try:
        results_file.unlink()
    except OSError:
        pass

    if result_data is not None:
        return _format_exec_result(result_data, is_query)

    if outcome.kind == DONE:
        return (
            "The editor acked the exec but produced no result file (nonce mismatch or missing output).\n"
            "Re-run a query to check current state."
        )
    if outcome.kind == ERROR:
        return f"EXEC ERROR: {outcome.detail}"
    if outcome.kind == UNAVAILABLE:
        return f"ERROR: {outcome.detail}"
    if (outcome.data or {}).get("noProgress"):
        return f"TIMEOUT: {outcome.detail}"
    if outcome.kind == EDITOR_DIED:
        return (
            f"EXEC ABORTED: the Unity editor exited or restarted during exec.\n{outcome.detail}\n"
            "Check unity.logs({ source: 'editor' })."
        )
    if (outcome.data or {}).get("begun"):
        return (
            f"TIMEOUT: unity.exec ran past its {timeout_seconds:g}s timeout. The editor had already started the snippet, "
            "so it may still be running there and finish on its own: check unity.status() before you run it again.\n"
            "For long work pass a higher timeout, like { timeout: 600 }."
        )
    return (
        f"TIMEOUT: {outcome.detail}\n"
        "The editor never started the snippet. Check that it is open and not stuck: unity.status().\n"
        "Common causes: a Unity dialog blocking or a long recompile or import — wait, or pass a higher timeout."
    )

def _read_exec_result(results_file: Path, nonce: str) -> dict | None:
    """Parsed exec result-file dict iff it's terminal and its nonce matches, else None."""
    if not results_file.exists():
        return None
    try:
        data = json.loads(results_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if data.get("status") not in ("completed", "error"):
        return None
    if data.get("nonce") != nonce:
        return None
    return data

def _remove_exec_script(script_path: Path):
    """Delete this exec's own source file — never a sibling's.

    The source lives in .sspace/exec (never under Assets/), so it is invisible to Unity's asset
    pipeline; removal is pure cleanup. Only OUR uid-named file is removed here so a concurrent exec's
    in-flight source is never clobbered."""
    try:
        script_path.unlink()
    except OSError:
        pass

STALE_RESULT_SECONDS = 24 * 3600

def _sweep_stale_exec_scripts(root: Path, exec_dir: Path, keep: str):
    """Remove orphaned _MCPExec_* sources left by a crashed prior exec, keeping ``keep``.

    Runs under the exec lock, so no other exec is mid-flight: any _MCPExec_* other than the one we're
    about to write is an orphan from a crash. Also sweeps Assets/Editor/_MCPExec_* leftovers from the
    pre-in-memory exec design (those DID live in Assets and would compile into the project)."""
    if exec_dir.is_dir():
        for p in exec_dir.glob("_MCPExec_*"):
            if p.name == keep:
                continue
            try:
                p.unlink()
            except OSError:
                pass
    stale = time.time() - STALE_RESULT_SECONDS
    for p in (root / ".sspace").glob(".mcp_exec_results.*.json"):
        try:
            if p.stat().st_mtime < stale:
                p.unlink()
        except OSError:
            pass
    legacy_dir = root / "Assets" / "Editor"
    if legacy_dir.is_dir():
        for p in legacy_dir.glob("_MCPExec_*"):
            try:
                p.unlink()
            except OSError:
                pass

SAVED_SHOWN = 8


def saved_files_text(paths: list[str]) -> str:
    shown = ", ".join(paths[:SAVED_SHOWN]) + (f" and {len(paths) - SAVED_SHOWN} more" if len(paths) > SAVED_SHOWN else "")
    count = f"{len(paths)} file{'s' if len(paths) != 1 else ''}"
    return f"this script wrote {count} to disk: {shown}. Save only when the user asked for it; tell them what was written."


def _format_exec_result(data: dict, is_query: bool = False) -> str:
    status = data.get("status", "")
    output = data.get("output", "").rstrip()
    error = data.get("error", "")

    dirty_scenes = ""
    saved: list[str] = []
    if _EXEC_DIRTY_MARKER in output or _EXEC_SAVED_MARKER in output:
        kept = []
        for line in output.splitlines():
            if line.startswith(_EXEC_DIRTY_MARKER):
                dirty_scenes = line[len(_EXEC_DIRTY_MARKER):].strip()
            elif line.startswith(_EXEC_SAVED_MARKER):
                saved = [p for p in line[len(_EXEC_SAVED_MARKER):].strip().split("|") if p]
            else:
                kept.append(line)
        output = "\n".join(kept).rstrip()

    lines = []
    if status == "error":
        lines.append(f"EXEC ERROR:\n{error}")
    else:
        lines.append("Exec completed.")

    if output:
        lines.append(f"\nOutput:\n{output}")
    elif is_query and status != "error":
        lines.append("(no output — did the code call Print()?)")
    elif status != "error":
        lines.append("Nothing was printed.")

    if saved:
        lines.append(f"\nNOTE (saved files): {saved_files_text(saved)}")
    if dirty_scenes:
        lines.append(
            f"\nNOTE (unsaved changes): {dirty_scenes} is now dirty — these edits live only in the editor's "
            "memory, NOT on disk. unity.openScene() reloads from disk and DISCARDS unsaved edits (same "
            "scene or a different one); entering Play Mode on the already-loaded scene KEEPS them. "
            "The user saves them; save from unity.exec() only when the user asked for it."
        )

    return "\n".join(lines)

MAX_SCREENSHOT_POINTS = 16

_POINTS_SHAPE = "[{ camera: [x, y, z], lookAt: [x, y, z] }, ...] or { frame: 'Level/Player' }"


def _shot_paths(i: int, key: str, value) -> tuple[list[str] | None, str | None]:
    items = value if isinstance(value, (list, tuple)) else [value]
    if not items or not all(isinstance(v, str) and v.strip() and "\n" not in v for v in items):
        return None, f"ERROR: pose {i + 1}: {key} takes a hierarchy path like 'Level/Player' or a list of them."
    return [v.strip() for v in items], None


def _parse_screenshot_points(points) -> tuple[list[tuple[list[float] | None, list[float] | None, dict]] | None, str | None]:
    if not isinstance(points, (list, tuple)) or not points:
        return None, f"ERROR: unity.screenshot() needs at least one pose: {_POINTS_SHAPE}."
    if len(points) > MAX_SCREENSHOT_POINTS:
        return None, (
            f"ERROR: at most {MAX_SCREENSHOT_POINTS} poses per screenshot, got {len(points)}. "
            "Split them across several calls."
        )
    parsed = []
    for i, point in enumerate(points):
        if not isinstance(point, dict):
            return None, f"ERROR: pose {i + 1} must be an object {{ camera: [x, y, z], lookAt: [x, y, z] }} or {{ frame: 'Level/Player' }}."
        shot: dict = {}
        for key in ("isolate", "hide"):
            if point.get(key) is not None:
                paths, err = _shot_paths(i, key, point[key])
                if err:
                    return None, err
                shot[key] = paths
        frame = point.get("frame")
        if frame is not None:
            if not isinstance(frame, str) or not frame.strip():
                return None, f"ERROR: pose {i + 1}: frame takes a hierarchy path like 'Level/Player'."
            if point.get("camera_pos") is not None or point.get("look_at") is not None:
                return None, f"ERROR: pose {i + 1}: frame places the camera itself, so leave out camera and lookAt."
            view = []
            for key in ("yaw", "pitch", "distance"):
                v = point.get(key, 0)
                if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                    return None, f"ERROR: pose {i + 1}: {key} must be a number."
                view.append(float(v))
            if view[2] < 0:
                return None, f"ERROR: pose {i + 1}: distance is in meters and can't be negative."
            shot["frame"] = frame.strip()
            shot["view"] = view
            extra = sorted(set(point) - {"frame", "yaw", "pitch", "distance", "isolate", "hide"})
            if extra:
                return None, f"ERROR: pose {i + 1} has unknown keys {extra}."
            parsed.append((None, None, shot))
            continue
        pair = []
        for key, shown in (("camera_pos", "camera"), ("look_at", "lookAt")):
            value = point.get(key)
            if value is None:
                return None, f"ERROR: pose {i + 1} is missing {shown} ([x, y, z]), or pass frame: 'Level/Player' instead."
            if not isinstance(value, (list, tuple)) or len(value) != 3:
                return None, f"ERROR: pose {i + 1}: {shown} must have exactly 3 elements [x, y, z]."
            try:
                if any(isinstance(v, bool) for v in value):
                    raise TypeError
                xyz = [float(v) for v in value]
            except (TypeError, ValueError):
                return None, f"ERROR: pose {i + 1}: {shown} must be numeric [x, y, z]."
            if not all(math.isfinite(v) for v in xyz):
                return None, f"ERROR: pose {i + 1}: {shown} must be finite numbers."
            pair.append(xyz)
        extra = sorted(set(point) - {"camera_pos", "look_at", "isolate", "hide"})
        if extra:
            return None, f"ERROR: pose {i + 1} has unknown keys {extra}; a pose has camera and lookAt, or frame, plus isolate and hide."
        if pair[0] == pair[1]:
            return None, f"ERROR: pose {i + 1}: camera and lookAt are the same point, so there is no direction to look in."
        parsed.append((pair[0], pair[1], shot))
    return parsed, None


def _grid_layout(n: int) -> tuple[int, int]:
    cols = max(1, math.ceil(math.sqrt(n)))
    return cols, max(1, math.ceil(n / cols))


def _png_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def _fmt_xyz(v: list[float]) -> str:
    return "[" + ", ".join(f"{c:g}" for c in v) + "]"


def _shot_text(cp, la, shot: dict) -> str:
    fmt = _fmt_xyz
    text = f"framing {shot['frame']}" if shot.get("frame") else f"camera {fmt(cp)} looking at {fmt(la)}"
    if shot.get("isolate"):
        text += f", only {', '.join(shot['isolate'])} drawn"
    if shot.get("hide"):
        text += f", {', '.join(shot['hide'])} hidden"
    return text


def _describe_points(parsed: list[tuple[list[float] | None, list[float] | None, dict]], size: tuple[int, int] | None) -> str:
    dims = f"{size[0]}x{size[1]}" if size else "unknown size"
    if len(parsed) == 1:
        return f"{dims}, {_shot_text(*parsed[0])}"
    cols, rows = _grid_layout(len(parsed))
    lines = [f"{dims}, {cols}x{rows} grid of {len(parsed)} tiles, row-major (left to right, top to bottom):"]
    for i, p in enumerate(parsed):
        lines.append(f"  #{i + 1} (row {i // cols + 1}, col {i % cols + 1}): {_shot_text(*p)}")
    return "\n".join(lines)


def _screenshot_outcome_error(outcome) -> str:
    if outcome.kind == ERROR:
        if "requires args.path" in (outcome.detail or ""):
            return (
                "SCREENSHOT ERROR: this editor still runs an engine build without multi-point grids "
                "(the engine update applies on the next editor launch). Pass one point per call, or "
                "relaunch the editor and retry."
            )
        return f"SCREENSHOT ERROR: {outcome.detail}"
    if outcome.kind == UNAVAILABLE:
        return f"ERROR: {outcome.detail}"
    if (outcome.data or {}).get("noProgress"):
        return f"TIMEOUT: {outcome.detail}"
    if outcome.kind == EDITOR_DIED:
        return f"SCREENSHOT ABORTED: the Unity editor exited during capture.\n{outcome.detail}"
    if outcome.kind == DIALOG_BLOCKED:
        return f"BLOCKED BY DIALOG: the screenshot cannot run.\n{outcome.detail}"
    return (
        f"TIMEOUT: {outcome.detail}\n"
        "The screenshot runs on the editor's main thread — if the editor is compiling or mid domain "
        "reload it captures right after; retry or raise timeout_seconds."
    )


@tool_guard
async def unity_screenshot(
    points: Annotated[list[dict], Field(description='1-16 camera poses: [{"camera_pos": [x, y, z], "look_at": [x, y, z]}, ...].')],
    save: Annotated[bool, Field(description="Write a PNG and return its path instead of the image.")] = False,
    path: Annotated[str, Field(description="Where to write the PNG, absolute or relative to the project (implies save). Default .sspace/screenshots/shot-<id>.png.")] = "",
    timeout_seconds: Annotated[float, Field(description="Seconds to wait.")] = 60,
    project_root: ProjectRoot = "",
):
    try:
        timeout_seconds = float(timeout_seconds)
    except (TypeError, ValueError):
        timeout_seconds = 60.0
    parsed, err = _parse_screenshot_points(points)
    if err:
        return err
    save = bool(save) or bool(path)
    project_root = resolve_root(project_root)
    root = Path(project_root)
    if not (root / "Assets").is_dir():
        return f"ERROR: Not a Unity project: {root}"

    err = await _ensure_unity_up(root)
    if err:
        return err

    stamp = f"{int(time.time() * 1000):x}"
    if not save:
        out = root / ".sspace" / "screenshots" / f".inline-{stamp}.png"
    elif path:
        out = Path(path).expanduser()
        if not out.is_absolute():
            out = root / out
    else:
        out = root / ".sspace" / "screenshots" / f"shot-{stamp}.png"
    if out.suffix.lower() != ".png":
        out = out.with_suffix(".png")
    try:
        ensure_sspace_for(out.parent)
        out.parent.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return f"ERROR: cannot create screenshot directory {out.parent}: {e}"
    try:
        out.unlink()
    except OSError:
        pass

    if len(parsed) == 1 and not parsed[0][2]:
        args = {"path": str(out), "cameraPos": parsed[0][0], "lookAt": parsed[0][1]}
    else:
        args = {"gridPath": str(out), "poses": [c for cp, la, _ in parsed for c in (*(cp or (0, 0, 0)), *(la or (0, 0, 1)))]}
        if any(shot.get("frame") for _, _, shot in parsed):
            args["frame"] = [shot.get("frame", "") for _, _, shot in parsed]
            args["view"] = [v for _, _, shot in parsed for v in shot.get("view", (0.0, 0.0, 0.0))]
        for key in ("isolate", "hide"):
            if any(shot.get(key) for _, _, shot in parsed):
                args[key] = ["\n".join(shot.get(key) or []) for _, _, shot in parsed]

    try:
        async with project_editor_lock(root, timeout_seconds, op="screenshot") as acquired:
            if not acquired:
                return _editor_busy_message(root, "screenshot", timeout_seconds)
            enq = await enqueue(root, "screenshot", args)
            if enq["error"]:
                return f"ERROR: could not enqueue screenshot: {enq['error']}"
            outcome = await await_command(
                root, enq["cmdId"], kind="screenshot",
                timeout_seconds=timeout_seconds,
            )

        if outcome.kind != DONE:
            return _screenshot_outcome_error(outcome)
        try:
            data = out.read_bytes() if out.is_file() else b""
        except OSError:
            data = b""
        if not data:
            return (
                "ERROR: the editor acked the screenshot but no file appeared at "
                f"{out} — check unity.logs() for '[MCPTestBridge] Screenshot'."
            )
        summary = _describe_points(parsed, _png_size(data))
        if save:
            return f"Screenshot saved: {out} ({len(data)} bytes), {summary}"
        return [f"Screenshot {summary}", Image(data=data, format="png")]
    finally:
        if not save:
            try:
                out.unlink()
            except OSError:
                pass
