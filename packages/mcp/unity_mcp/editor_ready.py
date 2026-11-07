import asyncio
import time
from pathlib import Path

from . import instances
from . import modal_status

DIALOG_REASON_PREFIX = "blocked by a modal dialog"
EARLY_PREFIX = "wait ended early: "

def editor_settled(root: Path) -> tuple[bool, str]:
    health = instances.editor_health(str(root))
    state = health.get("state")
    if state == "DOWN":
        return False, "editor is down"
    if health.get("isCompiling"):
        return False, "editor is compiling"
    if state == "BUSY":
        return False, "editor heartbeat is stale (compiling / reloading)"
    return True, "ready"


async def await_editor_ready(
    root: Path,
    *,
    timeout_seconds: float = 300.0,
    poll_interval: float = 0.5,
    on_tick=None,
) -> tuple[bool, str]:
    from .editor_watch import EditorWatch, capped
    deadline = time.monotonic() + max(0.0, capped(timeout_seconds))
    watch = EditorWatch(root, "the wait for the editor to settle")
    last_reason = "unknown"
    dialog_streak = 0
    while True:
        if on_tick is not None:
            try:
                on_tick()
            except Exception:
                pass
        dialogs = await asyncio.to_thread(modal_status.blocking_dialogs, root)
        if dialogs:
            dialog_streak += 1
            if dialog_streak >= 2:
                return False, (
                    f"{DIALOG_REASON_PREFIX}:\n"
                    + modal_status.dialog_block(root, dialogs)
                )
            last_reason = "a modal dialog is open"
        else:
            dialog_streak = 0
            ready, reason = await asyncio.to_thread(editor_settled, root)
            if ready:
                return True, reason
            last_reason = reason
            blocked = await watch.check()
            if blocked is not None:
                return False, EARLY_PREFIX + blocked.detail
        if time.monotonic() >= deadline:
            return False, last_reason
        await asyncio.sleep(poll_interval)
