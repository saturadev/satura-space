"""Outcome types shared by the command waiters."""
from dataclasses import dataclass

DONE = "done"
ERROR = "error"
EDITOR_DIED = "editor_died"
STALLED = "stalled"
DIALOG_BLOCKED = "dialog_blocked"
UNAVAILABLE = "unavailable"

@dataclass
class OpOutcome:
    """Structured result of awaiting an op. ``data`` is the parsed result-file dict when we have one."""
    kind: str
    data: dict | None = None
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.kind == DONE
