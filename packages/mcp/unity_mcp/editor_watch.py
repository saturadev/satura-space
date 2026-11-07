import asyncio
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from . import instances
from .op_await import STALLED, UNAVAILABLE, OpOutcome

NO_PROGRESS_SECONDS = float(os.environ.get("SATURA_MCP_NO_PROGRESS_SECONDS") or 30)
MAX_WAIT_SECONDS = 900
CPU_BUSY_SHARE = float(os.environ.get("SATURA_MCP_CPU_BUSY_SHARE") or 0.25)
_DOWN_GRACE = 1.2
_ORCH_EVERY = 0.75
_CPU_EVERY = 2.0
_NEXT = "Relaunch it with unity.relaunch(), or ask the user."


def capped(seconds: float) -> float:
    return min(float(seconds), float(MAX_WAIT_SECONDS))


def cap_note(asked: float) -> str:
    if asked <= MAX_WAIT_SECONDS:
        return ""
    return (f"timeout is capped at {MAX_WAIT_SECONDS} s, so this call waited at most {MAX_WAIT_SECONDS} s. "
            f"Waits also end early, with the reason, when Unity shows no progress for {NO_PROGRESS_SECONDS:.0f} s.")


def _cpu_seconds(pid: int) -> float | None:
    try:
        if sys.platform == "win32":
            import ctypes
            from ctypes import wintypes
            k32 = ctypes.windll.kernel32
            h = k32.OpenProcess(0x1000, False, int(pid))
            if not h:
                return None
            try:
                c, e, kt, ut = (wintypes.FILETIME() for _ in range(4))
                if not k32.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(e), ctypes.byref(kt), ctypes.byref(ut)):
                    return None
                ticks = (kt.dwHighDateTime << 32 | kt.dwLowDateTime) + (ut.dwHighDateTime << 32 | ut.dwLowDateTime)
                return ticks / 1e7
            finally:
                k32.CloseHandle(h)
        out = subprocess.run(["ps", "-o", "time=", "-p", str(int(pid))], capture_output=True, text=True, timeout=2).stdout.strip()
        if not out:
            return None
        days = 0.0
        if "-" in out:
            d, out = out.split("-", 1)
            days = float(d)
        total = 0.0
        for part in out.split(":"):
            total = total * 60 + float(part)
        return days * 86400 + total
    except (OSError, ValueError, subprocess.SubprocessError, AttributeError):
        return None


def _editor_logs(root: Path) -> list[Path]:
    logs = [root / ".sspace" / ".mcp_rawstream_editor.log", root / ".sspace" / ".mcp_editor.log"]
    if sys.platform == "darwin":
        logs.append(Path.home() / "Library" / "Logs" / "Unity" / "Editor.log")
    elif sys.platform == "win32" and os.environ.get("LOCALAPPDATA"):
        logs.append(Path(os.environ["LOCALAPPDATA"]) / "Unity" / "Editor" / "Editor.log")
    return logs


def _size(p: Path) -> int:
    try:
        return p.stat().st_size
    except OSError:
        return 0


def _newest_log(root: Path) -> Path | None:
    best = None
    for p in _editor_logs(root):
        try:
            m = p.stat().st_mtime
        except OSError:
            continue
        if best is None or m > best[0]:
            best = (m, p)
    return best[1] if best else None


_NOTEWORTHY = re.compile(r"\berror\b|exception|safe mode|crash|abort|fatal|no valid .*licen[cs]e", re.I)
_DIGITS = re.compile(r"\d+")
_STACK = re.compile(r"^\(Filename: |^[\w.`<>\[\],+/]+:[\w.`<>|+/,]+ ?\(.*\)( \(at .*\))?$")


def pick_lines(lines: list[str], count: int = 4) -> list[str]:
    lines = [l.strip() for l in lines if l.strip() and not _STACK.match(l.strip())]
    tail = lines[-(count - 1):]
    noteworthy = [l for l in lines[:-(count - 1)] if "warning" not in l.lower() and _NOTEWORTHY.search(l)]
    return [l[:300] for l in noteworthy[-1:] + tail]


def log_lines(root: Path, count: int = 4) -> list[str]:
    p = _newest_log(root)
    if p is None:
        return []
    try:
        with p.open("rb") as f:
            size = f.seek(0, 2)
            f.seek(max(0, size - 65536))
            text = f.read().decode("utf-8", errors="replace")
    except OSError:
        return []
    return pick_lines(text.splitlines()[1:], count)


def _log_block(lines) -> str:
    lines = [str(l) for l in (lines or []) if str(l).strip()]
    if not lines:
        return ""
    return "\nLast editor log lines:\n" + "\n".join(f"  {l}" for l in lines)


def describe_editor_state(ed: dict | None, root: Path) -> str | None:
    if not isinstance(ed, dict):
        return None
    state = ed.get("state")
    log = _log_block(ed.get("log") or log_lines(root))
    error = str(ed.get("error") or "").strip()
    if state == "exited":
        code, signal = ed.get("code"), ed.get("signal")
        how = f"was killed ({signal})" if signal else f"exited with code {code}" if code is not None else "exited"
        when = "" if ed.get("booted") else " while starting"
        extra = f" {error}" if "compile error" in error.lower() else ""
        return f"Unity isn't running: it {how}{when}.{extra}{log}\n{_NEXT}"
    if state == "failed":
        why = error or "It entered Safe Mode or stopped responding while starting."
        return f"Unity didn't start. {why}{log}\nFix what the log shows, then call unity.relaunch(), or ask the user."
    if state == "hub":
        return error or instances.HUB_NOT_RUNNING
    if state == "missing":
        return error or "This project needs a Unity version that isn't installed. Ask the user to install it in Unity Hub; unity.relaunch() waits for the install."
    if state == "refused":
        return error or "Satura Space refused to start Unity for this project."
    if state == "stopped":
        from .multiplayer import STOPPED_NOTE
        return STOPPED_NOTE
    if state == "none":
        return ("Unity isn't running for this project, and nothing is starting it." + log +
                "\nOpen the project's Unity panel in Satura Space, or call unity.relaunch(), or ask the user.")
    return None


async def orchestrator_editor(root: Path, timeout: float = 3.0) -> dict | None:
    from .multiplayer import orchestrator_present, request_player_command, resolve_player_dir
    real_root, player = resolve_player_dir(root)
    if not orchestrator_present(str(real_root)):
        return None
    r = await request_player_command(str(real_root), "status", extra={"target": player or "*"}, timeout=timeout)
    ed = r.get("editor") if isinstance(r, dict) else None
    return ed if isinstance(ed, dict) else None


async def unavailable_message(root: Path) -> str | None:
    ed = await orchestrator_editor(root)
    msg = describe_editor_state(ed, root)
    if msg:
        return msg
    if instances.editor_health(str(root)).get("state") != "DOWN":
        return None
    if ed is not None and ed.get("state") in ("launching", "up"):
        return None
    from .multiplayer import no_editor_message
    return f"Unity isn't running. {no_editor_message(str(root))}{_log_block(log_lines(root))}"


class EditorWatch:
    def __init__(self, root: Path, op: str, no_progress: float = NO_PROGRESS_SECONDS):
        self.root = Path(root)
        self.op = op
        self.no_progress = no_progress
        now = time.monotonic()
        self.started = now
        self.last_progress = now
        self.sig = None
        self.seen_pid = None
        self.down_since = None
        self.next_orch = 0.0
        self.ed = None
        self.cpu = None
        self.next_cpu = now + _CPU_EVERY
        self.offsets = {}
        self.seen_lines = set()

    def _new_log_lines(self) -> int:
        fresh = 0
        for p in [*_editor_logs(self.root)[:2], self.root / ".sspace" / ".mcp_logs" / "console.log"]:
            size = _size(p)
            start = self.offsets.get(p)
            if start is None or size < start:
                self.offsets[p] = size
                continue
            if size == start:
                continue
            begin = max(start, size - 65536)
            try:
                with p.open("rb") as f:
                    f.seek(begin)
                    raw = f.read(size - begin)
            except OSError:
                continue
            end = raw.rfind(b"\n")
            if end < 0:
                continue
            self.offsets[p] = begin + end + 1
            for line in raw[:end].decode("utf-8", errors="replace").splitlines():
                key = _DIGITS.sub("#", line.strip())
                if key and key not in self.seen_lines:
                    if len(self.seen_lines) < 20000:
                        self.seen_lines.add(key)
                    fresh += 1
        return fresh

    def _signature(self, health: dict) -> tuple:
        status = instances._read_status(self.root) or {}
        ed = self.ed or {}
        return (health.get("pid"), status.get("timestamp"), health.get("isCompiling"), ed.get("progress"))

    def _sample_cpu(self, pid, now: float) -> None:
        if not pid or now < self.next_cpu:
            return
        self.next_cpu = now + _CPU_EVERY
        cpu = _cpu_seconds(pid)
        if cpu is None:
            return
        if self.cpu and self.cpu[0] == pid and now > self.cpu[2]:
            share = (cpu - self.cpu[1]) / (now - self.cpu[2])
            if share >= CPU_BUSY_SHARE:
                self.last_progress = now
        self.cpu = (pid, cpu, now)

    def state_line(self, health: dict | None = None) -> str:
        health = health or instances.editor_health(str(self.root))
        parts = []
        st = health.get("state")
        if st == "BUSY":
            parts.append("its heartbeat stopped")
        if health.get("isCompiling"):
            parts.append("it reports compiling")
        ed = self.ed or {}
        if ed.get("progress"):
            parts.append(f"last progress: {ed['progress']}")
        if ed.get("state") == "launching":
            parts.append("it is still starting")
        return f" ({'; '.join(parts)})" if parts else ""

    def stalled(self, health: dict | None = None, begun_note: str = "") -> OpOutcome:
        idle = time.monotonic() - self.last_progress
        return OpOutcome(
            STALLED,
            data={"noProgress": True},
            detail=(f"Unity showed no progress for {idle:.0f} s during {self.op}{self.state_line(health)}, so the wait "
                    f"stopped. It may be frozen or waiting on something.{begun_note}{_log_block(log_lines(self.root))}\n"
                    "Check unity.status() and unity.logs({ source: 'editor' }). If it stays stuck, call "
                    "unity.relaunch(), or ask the user.") + instances.bridge_down_hint(str(self.root)),
        )

    async def check(self, *, idle: bool = True) -> OpOutcome | None:
        now = time.monotonic()
        health = await asyncio.to_thread(instances.editor_health, str(self.root))
        pid = health.get("pid") if health.get("state") != "DOWN" else None
        if now >= self.next_orch:
            self.next_orch = now + _ORCH_EVERY
            ed = await orchestrator_editor(self.root, timeout=2.0)
            if ed is not None:
                self.ed = ed
        ed = self.ed
        if ed is not None:
            st = ed.get("state")
            if st in ("exited", "failed", "hub", "missing", "refused", "stopped") or (st == "none" and not pid):
                return OpOutcome(UNAVAILABLE, detail=describe_editor_state(ed, self.root) or "")
        if pid:
            if self.seen_pid and pid != self.seen_pid:
                return OpOutcome(UNAVAILABLE, detail=(f"Unity exited during {self.op} and a new editor started (pid {self.seen_pid}, now {pid}), "
                                                      "so it may not have run. Call it again: it waits while Unity starts."))
            self.seen_pid = pid
            self.down_since = None
        else:
            launching = ed is not None and ed.get("state") == "launching"
            if self.down_since is None:
                self.down_since = now
            elif not launching and now - self.down_since >= _DOWN_GRACE:
                if self.seen_pid:
                    return OpOutcome(UNAVAILABLE, detail=f"Unity exited during {self.op} (pid {self.seen_pid}).{_log_block(log_lines(self.root))}\n{_NEXT}")
                msg = await unavailable_message(self.root)
                if msg:
                    return OpOutcome(UNAVAILABLE, detail=msg)
        if idle and self.idle_for(health) >= self.no_progress:
            return self.stalled(health)
        return None

    def idle_for(self, health: dict | None = None) -> float:
        now = time.monotonic()
        health = health or instances.editor_health(str(self.root))
        sig = self._signature(health)
        if self._new_log_lines() or sig != self.sig:
            self.sig = sig
            self.last_progress = now
        trusted = health.get("state") != "DOWN" and not health.get("unverified")
        self._sample_cpu(health.get("pid") if trusted else None, now)
        return now - self.last_progress
