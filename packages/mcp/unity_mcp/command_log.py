"""MCP side of the single Unity command-log queue (``.sspace/commands.json`` / ``command_acks.json``).

Every mutating editor op is one entry in an append-only command log that the editor drains strict-FIFO,
acking each into ``command_acks.json`` with a monotonic ``ackedCursor``. There is exactly ONE writer of
``commands.json`` per project: the Satura Space orchestrator when it manages the project, else this MCP
(standalone). ``enqueue`` picks the right path; ``append_command`` is the standalone writer and MUST run
under ``project_editor_lock`` so concurrent MCP tools can't collide on id allocation.
"""
import asyncio
import json
import os
import random
import sys
import time
from pathlib import Path

from .sspace import ensure_sspace_for


def _commands_path(root: Path) -> Path:
    return root / ".sspace" / "commands.json"


def _acks_path(root: Path) -> Path:
    return root / ".sspace" / "command_acks.json"


def read_acks(root: Path) -> dict:
    """Parsed ``command_acks.json`` as ``{ackedCursor, acks}``; empty and tolerant of missing/corrupt."""
    try:
        data = json.loads(_acks_path(root).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"ackedCursor": 0, "acks": []}
    if not isinstance(data, dict):
        return {"ackedCursor": 0, "acks": []}
    acks = data.get("acks") or []
    norm = []
    for a in acks:
        if not isinstance(a, dict):
            continue
        err = a.get("error")
        norm.append({
            "id": a.get("id"),
            "target": a.get("target"),
            "status": a.get("status"),
            "error": None if err == "" else err,
            "resultVersion": a.get("resultVersion"),
        })
    try:
        cursor = int(data.get("ackedCursor") or 0)
    except (TypeError, ValueError):
        cursor = 0
    return {"ackedCursor": cursor, "acks": norm}


def ack_for(root: Path, cmd_id: int) -> dict | None:
    """The explicit ack for ``cmd_id`` (applied/error/skipped), else None.

    ``ackedCursor`` is a CONSUMPTION marker, not a completion marker: the editor advances it the moment
    it BEGINS a command (so a domain reload never re-runs it from the log) and only writes the ack entry
    when the command finishes. Never infer completion from the cursor — a command with ``id <=
    ackedCursor`` and no entry is in progress (or died with the editor), not applied."""
    if cmd_id <= 0:
        return None
    for a in read_acks(root)["acks"]:
        if a.get("id") == cmd_id:
            return a
    return None


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ensure_sspace_for(path.parent)
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}.{random.randint(0, 1_000_000):x}")
    tmp.write_text(text, encoding="utf-8")
    attempts = 20 if sys.platform == "win32" else 1
    for attempt in range(1, attempts + 1):
        try:
            os.replace(str(tmp), str(path))
            return
        except PermissionError:
            if attempt >= attempts:
                try:
                    tmp.unlink()
                except OSError:
                    pass
                raise
            time.sleep(min(0.005 * attempt, 0.04))


def append_command(root: Path, target: str, kind: str, args: dict) -> int:
    """Append one command to ``commands.json`` and return its id. STANDALONE ONLY (no orchestrator) and
    MUST be called while holding ``project_editor_lock`` — it does a read-max-write that only stays
    collision-free while single-writer. Ids stay monotonic across the acked cursor and existing entries."""
    path = _commands_path(root)
    try:
        log = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        log = None
    if not isinstance(log, dict):
        log = {"schema": 1, "commands": []}
    commands = log.get("commands")
    if not isinstance(commands, list):
        commands = []

    acked_cursor = read_acks(root)["ackedCursor"]
    next_id = acked_cursor
    for c in commands:
        if isinstance(c, dict):
            try:
                next_id = max(next_id, int(c.get("id") or 0))
            except (TypeError, ValueError):
                pass
    next_id += 1

    kept = [c for c in commands if isinstance(c, dict) and int(c.get("id") or 0) > acked_cursor]
    kept.append({
        "id": next_id,
        "ts": int(time.time() * 1000),
        "target": target,
        "kind": kind,
        "args": args,
    })
    _atomic_write(path, json.dumps({"schema": 1, "commands": kept}))
    return next_id


async def enqueue(root: Path, kind: str, args: dict, target: str = "*") -> dict:
    """Enqueue one command and return ``{cmdId, error}``. Routes through the orchestrator when it manages
    this project (it is the sole ``commands.json`` writer), else appends directly (standalone; the caller
    must hold ``project_editor_lock``). ``cmdId`` 0 means the op is already satisfied (a convergent no-op)
    — awaiting it resolves DONE immediately, which is correct. A command the orchestrator recorded but
    could not issue yet comes back as ``error`` instead, so callers never report a deferred op as done.

    An orchestrator answer of "No live editor" means it has NO instance for this target (project tab or
    panel closed, or its editor exited) — it is not writing ``commands.json`` for such a project and it
    resets the queue files on its next launch, so when a heartbeat-live editor (e.g. an externally
    launched headless one) still owns the channel this appends directly instead of erroring — commands
    attach to that editor. With no live editor at all the error is returned with recovery guidance."""
    from .multiplayer import orchestrator_present, request_player_command, resolve_player_dir

    real_root, player_id = resolve_player_dir(root)
    if player_id and target == "*":
        target = player_id

    if orchestrator_present(str(real_root)):
        r = await request_player_command(
            str(real_root), "enqueue",
            extra={"kind": kind, "cmdArgs": args, "target": target},
        )
        if r.get("ok"):
            try:
                cid = int(r.get("cmdId") or 0)
            except (TypeError, ValueError):
                cid = 0
            return {"cmdId": cid, "error": None, "retryable": False}
        if r.get("unknownOutcome"):
            return {"cmdId": 0, "error": r.get("detail") or "UNKNOWN OUTCOME: check unity.status() before retrying.",
                    "retryable": False}
        err = r.get("error") or "enqueue failed"
        if "No live editor" in err:
            from . import instances
            if instances.editor_health(str(root)).get("state") != "DOWN":
                cid = append_command(root, target, kind, args)
                return {"cmdId": cid, "error": None, "retryable": False}
            err += (
                "\nNo editor process is running for this project (the orchestrator has no live "
                "instance for it). Call unity.relaunch() to start one, then retry."
            ) + instances.bridge_down_hint(str(root))
        return {"cmdId": 0, "error": err,
                "retryable": bool(r.get("retryable"))}

    cid = append_command(root, target, kind, args)
    return {"cmdId": cid, "error": None, "retryable": False}


async def enqueue_retry(root: Path, kind: str, args: dict, target: str = "*",
                        retry_seconds: float = 45.0, poll_seconds: float = 1.5) -> dict:
    """``enqueue`` with patience for the editor-settling window. Right after a play/stop transition or
    domain reload the orchestrator records the desired state but cannot issue the command yet; it answers
    with a ``retryable`` error (the op would apply on its own eventually, but the caller would have
    already reported failure). Re-enqueue until the editor takes it or ``retry_seconds`` elapses, then
    return the last result. Non-retryable errors and successes return immediately."""
    from . import instances
    from .editor_watch import EditorWatch, capped, unavailable_message
    deadline = time.monotonic() + capped(retry_seconds)
    watch = EditorWatch(root, f"'{kind}'")
    while True:
        r = await enqueue(root, kind, args, target)
        if not r.get("error") or not r.get("retryable") or time.monotonic() >= deadline:
            return r
        if instances.editor_health(str(root)).get("state") == "DOWN":
            msg = await unavailable_message(root)
            if msg:
                return {"cmdId": 0, "error": msg, "retryable": False, "unavailable": True}
        blocked = await watch.check()
        if blocked is not None:
            return {"cmdId": 0, "error": blocked.detail, "retryable": False, "unavailable": True}
        await asyncio.sleep(poll_seconds)
