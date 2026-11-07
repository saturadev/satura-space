"""Dialog listing/resolution over the native winhook modal protocol (see modal_status).

Deliberately does NOT go through the command log: a modal blocks the editor main thread, so a queued
command would sit unpumped behind the very dialog it is meant to answer. The native hook consumes the
cmd file on its own timer/thread, which keeps running while the editor is blocked.
"""
import asyncio
import json
import time
from pathlib import Path

from typing import Annotated, Literal

from pydantic import Field

from .params import ProjectRoot
from . import command_log
from . import instances
from . import modal_status
from .helpers import resolve_root, tool_guard


def _exec_result_snapshot(root_dir) -> dict[str, float]:
    out: dict[str, float] = {}
    for p in (Path(root_dir) / ".sspace").glob(".mcp_exec_results.*.json"):
        try:
            out[p.name] = p.stat().st_mtime
        except OSError:
            pass
    return out


def _pending_exec_scripts(root_dir) -> bool:
    exec_dir = Path(root_dir) / ".sspace" / "exec"
    return exec_dir.is_dir() and any(exec_dir.glob("_MCPExec_*.cs"))


async def _recover_blocked_exec(root_dir, before: dict[str, float], wait: float = 6.0) -> str:
    """After a dialog resolution unfreezes the editor, pick up the result of an exec that had reported
    BLOCKED — its Print output and status would otherwise be lost (the blocked call already returned).
    Only polls when a pending exec source exists; reports, then cleans up the result + source files."""
    if not _pending_exec_scripts(root_dir):
        return ""
    from .tools_bridge import _format_exec_result

    ss = Path(root_dir) / ".sspace"
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        for p in sorted(ss.glob(".mcp_exec_results.*.json")):
            try:
                if p.name in before and p.stat().st_mtime <= before[p.name]:
                    continue
                data = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if data.get("status") not in ("completed", "error"):
                continue
            try:
                p.unlink()
            except OSError:
                pass
            nonce = data.get("nonce") or ""
            if nonce:
                try:
                    (ss / "exec" / f"_MCPExec_{nonce}.cs").unlink()
                except OSError:
                    pass
            return (
                "\nThe exec that was blocked by this dialog finished after resolution. Its result:\n"
                + _format_exec_result(data)
            )
        await asyncio.sleep(0.4)
    return ""


def _listing(found: list) -> list[str]:
    lines = []
    for d, dlg in found:
        lines.append(f"Instance: {d}")
        lines.extend(modal_status.describe_dialog(dlg))
    return lines


def _consumed_command_in_flight(root_dir) -> bool:
    """True when the editor consumed a command it has not terminally acked. Read while the editor is
    still frozen by the dialog, so the answer cannot race the post-click resume."""
    try:
        cursor = int(command_log.read_acks(root_dir).get("ackedCursor") or 0)
        return cursor > 0 and command_log.ack_for(root_dir, cursor) is None
    except (OSError, ValueError, TypeError, KeyError):
        return False


@tool_guard
async def unity_resolve_dialog(
    action: Annotated[Literal["", "click", "close"], Field(description='"" lists open dialogs, "click" presses button, "close" closes a dialog that has no buttons.')] = "",
    dialog_id: Annotated[str, Field(description="Dialog id from the listing or a BLOCKED BY DIALOG report. Can be left out when only one is open.")] = "",
    button: Annotated[str, Field(description="click: the button label. Exact match first, then case-insensitive.")] = "",
    timeout_seconds: Annotated[int, Field(description="Seconds to wait for the dialog to go away.")] = 15,
    project_root: ProjectRoot = "",
) -> str:
    project_root = resolve_root(project_root)
    action = (action or "").strip().lower()

    found = []
    swept: list = []
    for d in modal_status.instance_dirs(project_root):
        for dlg in modal_status.active_dialogs(d, swept):
            found.append((d, dlg))
    swept_lines = [
        f"(removed a stale dialog-status file from a dead editor, pid {pid}, at {d} — if that "
        "editor should be running, unity.relaunch() it)"
        for d, pid in swept
    ]

    if action == "":
        if not found:
            return "\n".join(swept_lines + [
                "No dialogs open on any instance.\n"
                "(Only editors launched by the Satura Space orchestrator report dialogs — a headless "
                "build server or a user's own editor has no hook.)"
            ])
        lines = swept_lines + [f"{len(found)} open dialog(s):"]
        lines.extend(_listing(found))
        lines.append(
            "Resolve with unity.answer('<label>', { id: '<id>' }) "
            "or unity.closeDialog(id) (buttonless dialogs only)."
        )
        return "\n".join(lines)

    if action not in ("click", "close"):
        return "ERROR: action must be '' (list), 'click', or 'close'."

    if dialog_id:
        matches = [(d, dlg) for d, dlg in found if dlg.get("id") == dialog_id]
        if not matches:
            if not found:
                return (
                    f"ERROR: no open dialog with id '{dialog_id}' — no dialogs are open on any instance. "
                    "It was likely already answered; retry the original call."
                )
            return "\n".join(
                [f"ERROR: no open dialog with id '{dialog_id}'. Open dialogs:"] + _listing(found)
            )
        target = matches[0]
    elif len(found) == 1:
        target = found[0]
    elif not found:
        return "ERROR: No dialog is open, so there is nothing to answer or close. unity.dialogs() lists them."
    else:
        return "\n".join(
            ["ERROR: multiple dialogs are open — pass the id: unity.answer(button, {id}). Open dialogs:"] + _listing(found)
        )

    root_dir, dlg = target
    did = dlg.get("id") or ""
    title = dlg.get("title") or "<untitled>"
    labels = dlg.get("buttons") or []

    if action == "click":
        if not button:
            opts = ", ".join(f"'{modal_status.normalize_label(b)}'" for b in labels) or "<none detected>"
            return f"ERROR: unity.answer() needs the label of the button to press. Buttons on '{title}': {opts}"
        if not labels:
            return (
                f"ERROR: no buttons were detected on dialog '{title}' (a Unity-rendered dialog the "
                "hook cannot read into) — use unity.closeDialog(id) instead."
            )
        raw = modal_status.resolve_button(labels, button)
        if raw is None:
            opts = ", ".join(f"'{modal_status.normalize_label(b)}'" for b in labels)
            return f"ERROR: dialog '{title}' has no button '{button}'. Buttons: {opts}"
        button = raw

    if action == "close" and labels:
        opts = ", ".join(f"'{modal_status.normalize_label(b)}'" for b in labels)
        return (
            f"ERROR: dialog '{title}' has buttons ({opts}) — unity.closeDialog() would silently take its "
            "cancel path, answering the dialog with an implicit choice. Click an explicit button "
            "with unity.answer(button) instead; closeDialog is only for dialogs with no detected buttons."
        )

    begun = _consumed_command_in_flight(root_dir)
    exec_before = _exec_result_snapshot(root_dir)
    seq = modal_status.write_cmd(root_dir, did, action, button if action == "click" else "")
    res = await modal_status.wait_resolution(
        root_dir, did, seq, timeout=max(1.0, float(timeout_seconds))
    )
    ack, gone = res["ack"], res["gone"]

    health = instances.editor_health(str(root_dir))
    state_line = f"Editor state: {health.get('state')} (pid={health.get('pid') or '—'})."

    if ack is None:
        if gone:
            return (
                f"Dialog '{title}' is gone (it resolved before the command was consumed — likely "
                f"answered by the user or self-dismissed). {state_line}\nRetry the original call."
            )
        return (
            f"TIMEOUT: the window hook did not acknowledge the command within {timeout_seconds}s and "
            f"dialog '{title}' is still open. {state_line}\n"
            "If the editor is DOWN it died mid-dialog — use unity.relaunch(). Otherwise retry, or ask "
            "the user to answer the dialog on screen."
        )

    outcome = ack.get("outcome")
    detail = ack.get("detail") or ""
    if outcome in ("clicked", "closed"):
        what = (
            f"clicked '{modal_status.normalize_label(detail)}'"
            if outcome == "clicked" and detail
            else outcome
        )
        if gone:
            if begun:
                exec_note = await _recover_blocked_exec(root_dir, exec_before)
                return (
                    f"Resolved dialog '{title}' ({what}). The editor's main thread resumed and is "
                    "finishing the command it had already consumed — do NOT retry it (you may run it "
                    f"twice); re-check state with unity.status() / unity.logs(). {state_line}"
                    f"{exec_note}"
                )
            return (
                f"Resolved dialog '{title}' ({what}). The editor's main thread resumed — no consumed "
                f"command was pending, so retry the call that reported BLOCKED. {state_line}"
            )
        return (
            f"The hook {what} on dialog '{title}', but the dialog is still listed as open — it may "
            f"need a different button, or a second dialog appeared. {state_line}\n"
            "Run unity.dialogs() to re-list."
        )
    if outcome == "button_not_found":
        opts = ", ".join(f"'{modal_status.normalize_label(b)}'" for b in labels) or "<none>"
        return (
            f"ERROR: the hook could not find button '{button}' on dialog '{title}' "
            f"(buttons at last scan: {opts}). Re-list with unity.dialogs() and retry."
        )
    if outcome == "not_found":
        return (
            f"Dialog '{title}' was already gone when the hook processed the command "
            f"{'and is no longer listed' if gone else 'but is still listed — re-list to confirm'}. "
            f"{state_line}"
        )
    return (
        f"ERROR: the hook reported '{outcome}' for dialog '{title}'"
        + (f" ({detail})" if detail else "")
        + f". {state_line}"
    )
