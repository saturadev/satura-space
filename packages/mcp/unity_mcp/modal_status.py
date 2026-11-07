"""Read and drive the native winhook modal-dialog protocol.

A blocking modal (DisplayDialog, save prompt, Safe Mode, API updater, …) halts the editor's main
thread, so the C# bridge can neither report nor answer it. The injected native hook keeps running and
publishes every visible dialog (title/message/buttons) to ``.sspace/.modal_status.json``, and consumes
click/close commands from ``.sspace/.modal_cmd.json`` (strictly increasing ``seq``, acked back through
the status file's ``lastCmd``). This module is the Python end of that protocol: the await loops poll
``active_dialogs`` to fail fast with the dialog's contents instead of a generic stall, and
``unity.answer()`` uses ``write_cmd``/``wait_resolution`` to answer it. Editors without the hook
(headless build server, a user's own editor) have no status file and degrade to the old behavior.

The cmd channel is single-consumer, last-writer-wins: two MCP servers racing ``write_cmd`` in the
same millisecond produce the same seq, the later file overwrites the earlier, and both waiters accept
the surviving command's ack. Acceptable — both were trying to unblock the same editor.
"""
import asyncio
import json
import re
import time
from pathlib import Path

from . import instances
from .sspace import ensure_sspace

MODAL_STATUS_FILE = ".modal_status.json"
MODAL_CMD_FILE = ".modal_cmd.json"

DIALOG_CONFIRM_SECONDS = 0.5

LOOP_STALL_SECONDS = 6.0


def _status_path(root: Path) -> Path:
    return Path(root) / ".sspace" / MODAL_STATUS_FILE


def _cmd_path(root: Path) -> Path:
    return Path(root) / ".sspace" / MODAL_CMD_FILE


def read_status(root: Path) -> dict | None:
    try:
        data = json.loads(_status_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def normalize_label(label: str) -> str:
    """A Win32 button caption without its accelerator markers: '&ConfirmYes' -> 'ConfirmYes',
    'C&ancelNo' -> 'CancelNo', '&&' stays a literal '&'."""
    return (label or "").replace("&&", "\x00").replace("&", "").replace("\x00", "&")


def resolve_button(labels: list[str], want: str) -> str | None:
    """Map a caller-supplied button name to the RAW label the hook needs, tolerating accelerator '&'
    and case differences. Returns None when nothing matches."""
    for b in labels:
        if b == want:
            return b
    nw = normalize_label(want)
    for b in labels:
        if normalize_label(b) == nw:
            return b
    for b in labels:
        if b.lower() == want.lower():
            return b
    for b in labels:
        if normalize_label(b).lower() == nw.lower():
            return b
    return None


_STALE_STATUS_MIN_AGE = 10.0


def active_dialogs(root: Path, swept: list | None = None) -> list[dict]:
    """The dialogs currently open on this instance, or ``[]``. A status file whose writer pid is dead
    is stale (leftover from a previous editor) and reads as no dialogs; it is also DELETED (once it
    is old enough to rule out racing a just-written file) so a later pid reuse cannot resurrect a
    phantom dialog. ``swept`` (optional list) collects ``(root, pid)`` for each file removed."""
    data = read_status(root)
    if not data:
        return []
    pid = data.get("pid")
    if not pid or not instances._alive(pid):
        path = _status_path(root)
        try:
            if time.time() - path.stat().st_mtime > _STALE_STATUS_MIN_AGE:
                path.unlink()
                if swept is not None:
                    swept.append((Path(root), pid))
        except OSError:
            pass
        return []
    return [d for d in (data.get("dialogs") or []) if isinstance(d, dict)]


def editor_loop_stalled(root: Path, stall_seconds: float = LOOP_STALL_SECONDS) -> bool:
    """True when the editor's main-loop heartbeat (the ``.mcp_status.json`` timestamp, written every
    ~2s while the update loop runs) has not advanced for ``stall_seconds``. A blocking modal freezes
    that loop, so a live heartbeat proves a sighted dialog is benign — e.g. a tooltip, dropdown, or
    utility window on a revealed editor. No readable status file means liveness cannot be proven and
    reads as stalled, preserving fail-fast behavior for editors without the bridge."""
    status = instances._read_status(Path(root))
    if not status:
        return True
    try:
        ts = float(status.get("timestamp") or 0)
    except (TypeError, ValueError):
        return True
    return time.time() - ts >= stall_seconds


def blocking_dialogs(root: Path, stall_seconds: float = LOOP_STALL_SECONDS) -> list[dict]:
    """``active_dialogs`` filtered to the blocking case: dialogs count only while the editor loop is
    stalled. Use this to FAIL an operation; use ``active_dialogs`` to list or resolve dialogs."""
    dialogs = active_dialogs(root)
    if not dialogs:
        return []
    return dialogs if editor_loop_stalled(root, stall_seconds) else []


def describe_dialog(d: dict, indent: str = "  ") -> list[str]:
    title = d.get("title") or "<untitled>"
    out = [f"{indent}Dialog id={d.get('id')}  title='{title}'"]
    msg = (d.get("message") or "").strip()
    complete = d.get("textComplete", True)
    if msg:
        suffix = "" if complete else "  (text may be incomplete)"
        out.append(f"{indent}  message: {msg}{suffix}")
    elif not complete:
        out.append(f"{indent}  message: <unreadable — title only>")
    buttons = d.get("buttons") or []
    if buttons:
        out.append(f"{indent}  buttons: " + ", ".join(f"'{normalize_label(b)}'" for b in buttons))
    else:
        out.append(f"{indent}  buttons: <none detected — use unity.closeDialog(id)>")
    return out


def dialog_block(root: Path, dialogs: list[dict], *, resumes: bool = False) -> str:
    """The agent-facing BLOCKED BY DIALOG report. ``resumes=True`` means the editor already consumed
    the blocked command (it will finish on its own once the dialog is answered), so the advice must
    be re-check rather than retry — retrying a consumed mutation would run it twice."""
    lines = [
        "A modal dialog is blocking the Unity editor's main thread — queued commands cannot run "
        "until it is answered.",
        f"Instance: {root}",
    ]
    for d in dialogs:
        lines.extend(describe_dialog(d))
    if resumes:
        lines.append(
            "Resolve it with unity.answer('<label>', { id: '<id>' }) "
            "(or unity.closeDialog(id)). The editor already consumed this command — it will resume and finish "
            "on its own once the dialog is answered, so re-check state (unity.status() / "
            "unity.logs()) instead of retrying, or you may run it twice."
        )
    else:
        lines.append(
            "Resolve it with unity.answer('<label>', { id: '<id>' }) "
            "(or unity.closeDialog(id)), then retry this call."
        )
    return "\n".join(lines)


def _read_cmd_seq(root: Path) -> int:
    try:
        return int(json.loads(_cmd_path(root).read_text(encoding="utf-8")).get("seq") or 0)
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return 0


def write_cmd(root: Path, dialog_id: str, action: str, button: str = "") -> int:
    """Write a resolution command for the hook and return its seq. The seq is derived from the status
    seq, the last ack, any pending cmd file, and epoch-ms, so it is strictly greater than anything the
    hook has already consumed."""
    status = read_status(root) or {}
    last = status.get("lastCmd") or {}
    try:
        floor = max(int(status.get("seq") or 0), int(last.get("seq") or 0))
    except (TypeError, ValueError):
        floor = 0
    seq = max(floor, _read_cmd_seq(root), int(time.time() * 1000)) + 1
    payload = {"v": 1, "seq": seq, "id": dialog_id, "action": action}
    if button:
        payload["button"] = button
    path = _cmd_path(root)
    ensure_sspace(root)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    for attempt in range(3):
        try:
            tmp.replace(path)
            break
        except OSError:
            if attempt == 2:
                raise
            time.sleep(0.05)
    return seq


async def wait_resolution(
    root: Path, dialog_id: str, seq: int, *, timeout: float = 15.0, poll: float = 0.3
) -> dict:
    """Wait for the hook to ack cmd ``seq`` and for ``dialog_id`` to leave the dialog list.
    Returns ``{"ack": lastCmd-or-None, "gone": bool}``; a failed ack (not_found/button_not_found/error)
    returns as soon as it appears."""
    deadline = time.monotonic() + timeout
    acked = None
    while time.monotonic() < deadline:
        data = read_status(root) or {}
        last = data.get("lastCmd") or {}
        try:
            if acked is None and int(last.get("seq") or 0) >= seq:
                acked = last
        except (TypeError, ValueError):
            pass
        gone = all(d.get("id") != dialog_id for d in (data.get("dialogs") or []) if isinstance(d, dict))
        if acked is not None and gone:
            return {"ack": acked, "gone": True}
        if acked is not None and acked.get("outcome") not in ("clicked", "closed"):
            return {"ack": acked, "gone": gone}
        await asyncio.sleep(poll)
    data = read_status(root) or {}
    gone = all(d.get("id") != dialog_id for d in (data.get("dialogs") or []) if isinstance(d, dict))
    return {"ack": acked, "gone": gone}


def instance_dirs(project_root: str = "") -> list[Path]:
    """The primary root plus every clone dir, whether or not their editors look healthy — a modal
    freezes the heartbeat, so a blocked editor can read as BUSY/DOWN and must still be scanned."""
    root = instances._root(project_root)
    dirs = [root]
    vp = root / "Library" / "VP"
    if vp.is_dir():
        dirs.extend(sorted((d for d in vp.iterdir() if d.is_dir()), key=lambda p: p.name))
    return dirs


def players_dialog_note(project_root: str = "") -> str:
    """Fleet-wide warning line(s) for players_summary — empty string when no instance has a dialog."""
    lines = []
    for d in instance_dirs(project_root):
        for dlg in active_dialogs(d):
            title = dlg.get("title") or "<untitled>"
            buttons = [normalize_label(b) for b in (dlg.get("buttons") or [])]
            suffix = f" [{', '.join(buttons)}]" if buttons else ""
            lines.append(f"WARNING: open dialog on {d}: '{title}'{suffix} (id={dlg.get('id')})")
    if not lines:
        return ""
    lines.append(
        "A blocking modal freezes that editor's main thread until answered — resolve it with "
        "unity.answer() (benign popups on a revealed editor close on their own)."
    )
    return "\n".join(lines)


SAFE_ANSWERS = [
    (re.compile(r"backup", re.I), re.compile(r"^keep backups?$", re.I)),
    (re.compile(r"corrupted library|rebuild (the )?library", re.I), re.compile(r"^don'?t rebuild", re.I)),
    (re.compile(r"input system native platform backend", re.I), re.compile(r"^don'?t enable", re.I)),
    (re.compile(r"api update", re.I), re.compile(r"^(no thanks|skip|cancel)$", re.I)),
]


def safe_button(d: dict) -> str | None:
    """The raw label of the known non-destructive answer for ``d``, or None when the dialog is not on
    the known-safe list (the caller must then report it instead of clicking anything)."""
    text = f"{d.get('title') or ''} {d.get('message') or ''}"
    buttons = [b for b in (d.get("buttons") or []) if isinstance(b, str)]
    for match, button in SAFE_ANSWERS:
        if match.search(text):
            for b in buttons:
                if button.search(normalize_label(b).strip()):
                    return b
    return None


async def answer_safe(root: Path, dialogs: list[dict]) -> tuple[list[str], list[dict]]:
    """Click the known-safe button on each dialog. Returns (answered descriptions, dialogs left
    blocking: unknown ones, ones without a safe button, and ones whose click did not land)."""
    answered: list[str] = []
    blocked: list[dict] = []
    for d in dialogs:
        button = safe_button(d)
        if not button or not d.get("id"):
            blocked.append(d)
            continue
        seq = await asyncio.to_thread(write_cmd, root, str(d["id"]), "click", button)
        res = await wait_resolution(root, str(d["id"]), seq)
        if res.get("gone"):
            answered.append(f"'{d.get('title') or '<untitled>'}' -> '{normalize_label(button)}'")
        else:
            blocked.append(d)
    return answered, blocked
