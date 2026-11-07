"""Await a queued Unity command to be acked. ``EditorWatch`` ends the wait early when the editor can't
finish it (not running, exited, failed to start, no progress for ``NO_PROGRESS_SECONDS``), and
``timeout_seconds`` (capped at ``MAX_WAIT_SECONDS``) is the most it waits while Unity keeps progressing.
"""
import asyncio
import os
import time
from pathlib import Path

from . import command_log
from . import modal_status
from .editor_watch import NO_PROGRESS_SECONDS, EditorWatch, capped
from .op_await import (
    DIALOG_BLOCKED,
    DONE,
    ERROR,
    STALLED,
    OpOutcome,
)


_POLL_SECONDS = float(os.environ.get("SATURA_MCP_POLL_SECONDS") or 0.2)
_FAST_POLL_SECONDS = 0.02
_FAST_POLL_WINDOW = 2.0


async def await_command(
    root: Path,
    cmd_id: int,
    *,
    kind: str,
    timeout_seconds: float = 300.0,
    idle_ceiling: float | None = None,
    poll_interval: float | None = None,
    on_tick=None,
) -> OpOutcome:
    if cmd_id <= 0:
        return OpOutcome(DONE)
    fast_until = 0.0
    if poll_interval is None:
        poll_interval = _POLL_SECONDS
        fast_until = time.monotonic() + _FAST_POLL_WINDOW

    ceiling = capped(timeout_seconds)
    hard_deadline = time.monotonic() + ceiling
    watch = EditorWatch(root, f"'{kind}'", NO_PROGRESS_SECONDS if idle_ceiling is None else idle_ceiling)
    begun = False
    dialog_streak = 0
    dialog_since = 0.0

    def acked() -> OpOutcome | None:
        ack = command_log.ack_for(root, cmd_id)
        if ack is None:
            return None
        if ack.get("status") == "error":
            return OpOutcome(ERROR, detail=ack.get("error") or f"'{kind}' failed.")
        return OpOutcome(DONE)

    next_tick = 0.0
    while True:
        if on_tick is not None and time.monotonic() >= next_tick:
            next_tick = time.monotonic() + poll_interval
            try:
                on_tick()
            except Exception:
                pass

        done = acked()
        if done is not None:
            return done

        if not begun and command_log.read_acks(root)["ackedCursor"] >= cmd_id:
            begun = True

        blocked = await watch.check()
        if blocked is not None:
            done = acked()
            if done is not None:
                return done
            if blocked.kind == STALLED and begun:
                blocked.detail += (f"\nUnity had already started '{kind}', so it may still finish on its own: "
                                   "check unity.status() before you run it again.")
            blocked.data = {**(blocked.data or {}), "begun": begun}
            return blocked

        dialogs = modal_status.blocking_dialogs(root)
        if dialogs:
            if dialog_streak == 0:
                dialog_since = time.monotonic()
            dialog_streak += 1
            if dialog_streak >= 2 and time.monotonic() - dialog_since >= modal_status.DIALOG_CONFIRM_SECONDS:
                done = acked()
                if done is not None:
                    return done
                return OpOutcome(
                    DIALOG_BLOCKED,
                    data={"dialogs": dialogs, "begun": begun},
                    detail=modal_status.dialog_block(root, dialogs, resumes=begun),
                )
        else:
            dialog_streak = 0

        now = time.monotonic()
        if now >= hard_deadline:
            return OpOutcome(STALLED, data={"begun": begun},
                             detail=f"'{kind}' was still running after {ceiling:.0f} s, the most this call waits. "
                                    "Unity was still making progress.")

        await asyncio.sleep(_FAST_POLL_SECONDS if now < fast_until else poll_interval)
