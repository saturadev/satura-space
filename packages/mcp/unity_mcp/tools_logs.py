"""Snapshot Unity logs straight off disk — the MCP equivalent of the Player panel's Console.

Pure disk read (no orchestrator round-trip): for each targeted editor we surface, in one shot, the
things you actually need to judge its health — compile errors, the structured console
(severity-filterable), and the raw startup/editor log. Crucially this works even when the editor is
NOT "live": a still-booting or crashed editor never shows up in ``discover_players``, but its logs
are already on disk, so we fall back to reading the project root (and ``Library/VP`` clone dirs)
directly. That makes ``unity.logs()`` the way to validate progress after ``unity.relaunch()``: poll it to
watch startup, catch compile/startup errors, and confirm the editor came up. ``source='tags'`` reads the
SaturaLog tag files instead (``tag_logs``), after asking live editors to flush them.

Log layout per editor dir (``<dir>/.sspace/``):
  .mcp_logs/console.log        structured Unity console (``[F:n T:t] SEV msg``); per-run — truncated
                               on every Play Mode entry and at editor-session start
  .mcp_logs/orchestrator.log   orchestrator's compile-error summary (plain lines; empty when none)
  .mcp_rawstream_editor.log    raw Unity -logFile of an orchestrator-streamed editor (startup/crash)
  .mcp_editor.log              raw Unity -logFile of the MCP's own headless build server
"""
import asyncio
import os
import re
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field

from .tag_logs import tag_logs
from .command_await import await_command
from .command_log import enqueue
from .helpers import default_root, tool_guard
from .multiplayer import discover_players, player_label, select_targets
from .params import ProjectRoot

HEADER_RE = re.compile(r"^﻿?\[F:(-?\d+) T:([\d.]+)\] ([LWEPR]) ?(.*)$")
SEV_MAP = {"L": "log", "W": "warn", "E": "error", "P": "log", "R": "log"}
SEED_TAIL_BYTES = 256 * 1024

def _root(project_root: str) -> str:
    return os.path.abspath(os.path.expanduser(project_root or default_root()))

def _ss(dir_path: str) -> Path:
    return Path(dir_path) / ".sspace"

def _tail_lines(path: Path) -> list[str]:
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size > SEED_TAIL_BYTES:
                f.seek(size - SEED_TAIL_BYTES)
            data = f.read()
    except OSError as e:
        return [f"({path.name} temporarily unreadable: {e.strerror or e} — retry in a moment)"]
    lines = data.decode("utf-8", errors="replace").splitlines()
    if size > SEED_TAIL_BYTES and lines:
        lines = lines[1:]
    return lines

def _clip(body: list[str], lines: int) -> list[str]:
    if not lines or lines <= 0 or len(body) <= lines:
        return body
    hidden = len(body) - lines
    return [f"… {hidden} older line(s) hidden (raise `lines` to see more) …", *body[-lines:]]

def _clip_records(body: list[str], lines: int) -> list[str]:
    if not lines or lines <= 0 or len(body) <= lines:
        return body
    start = len(body) - lines
    for back in range(start, max(-1, start - 80), -1):
        if HEADER_RE.match(body[back]):
            start = back
            break
    if start == 0:
        return body
    return [f"… {start} older line(s) hidden (raise `lines` to see more) …", *body[start:]]

def _grep(body: list[str], pat) -> list[str]:
    """Keep only lines matching the compiled regex (searched anywhere in the line). None = no filter."""
    if pat is None:
        return body
    return [ln for ln in body if pat.search(ln)]

_ENGINE_NOISE_RE = re.compile(
    r"^\[Tuner\] (\S+ gizmos: |enter state default of .* \(0 setup steps, 0 overrides applied\)$|\S+ now in (Play|Edit) Mode \(|framing )"
    r"|^\[Tuner\] ((start|stop) )?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"
    r"|^\[Tuner\] (runtime clone sources |Gizmos\.DrawIcon is skipped|editor update interval )"
    r"|^\[tunerInspector\] "
)

_STACK_NOISE_RE = re.compile(
    r"^\s+(UnityEngine\.(Debug|Logger|DebugLogHandler|StackTraceUtility)[:.]|System\.Reflection\.|System\.RuntimeMethodHandle"
    r"|HotReloadPrototype\.|MCPTestBridge[.:]|SaturaSpace\.Engine\.|UnityEditor\.EditorApplication[.:]Internal_Call)"
)
_STACK_SUBS = (
    (re.compile(r"_MCPExec_[0-9a-f]+(?:\+<>c)?[.:]"), ""),
    (re.compile(r"<(\w+)>b__\d+(?:_\d+)?"), r"\1 (lambda)"),
    (re.compile(r"\(at /Users/bokken/[^)]*/([^/)]+)\)"), r"(at Unity \1)"),
)
_STACK_CAP = 10

def _trim_stack(rec: list[str]) -> list[str]:
    frames = []
    for ln in rec[1:]:
        if _STACK_NOISE_RE.match(ln):
            continue
        for rx, sub in _STACK_SUBS:
            ln = rx.sub(sub, ln)
        frames.append(ln)
    if len(frames) > _STACK_CAP:
        frames = frames[:_STACK_CAP] + [f"    … {len(frames) - _STACK_CAP} more frames"]
    return [rec[0], *frames]

def _drop_engine_noise(lines: list[str]) -> list[str]:
    out: list[str] = []
    for rec in _split_records(lines):
        m = HEADER_RE.match(rec[0])
        if m and m.group(3) == "L" and _ENGINE_NOISE_RE.match(m.group(4)):
            continue
        out.extend(_trim_stack(rec) if m and len(rec) > 1 else rec)
    return out

def _grep_records(body: list[str], pat) -> list[str]:
    if pat is None:
        return body
    out: list[str] = []
    for rec in _split_records(body):
        if any(pat.search(ln) for ln in rec):
            out.extend(rec)
    return out

def _filter_structured(lines: list[str], severity: str) -> list[str]:
    """Keep records (a header + its 4-space-indented stack lines) whose severity matches."""
    out: list[str] = []
    keep = severity == "all"
    for ln in lines:
        m = HEADER_RE.match(ln)
        if m:
            sev = SEV_MAP.get(m.group(3), "log")
            keep = severity == "all" or sev == severity
            if keep:
                out.append(ln)
        elif keep:
            out.append(ln)
    return out

def _split_records(lines: list[str]) -> list[list[str]]:
    """Group a structured console into records: each header line plus its 4-space-indented
    continuation/stack lines. Leading non-header lines (rare) become a record of their own."""
    records: list[list[str]] = []
    cur: list[str] = []
    for ln in lines:
        if HEADER_RE.match(ln):
            if cur:
                records.append(cur)
            cur = [ln]
        elif cur:
            cur.append(ln)
        else:
            cur = [ln]
    if cur:
        records.append(cur)
    return records

def _collapse_records(lines: list[str]) -> list[str]:
    """Collapse ALL identical console records into one — Unity Console's Collapse, not just runs.

    Two records are "identical" when severity, message body, and stack match (the per-occurrence
    ``[F:n T:t]`` prefix is ignored), exactly like the Console panel's Collapse toggle. Unlike the
    panel we keep each unique record at its MOST RECENT position with its latest header, so the tail
    of the output still reads as "what's happening now" and clipping to ``lines`` drops stale spam
    first. Repeats gain ``(×N, first F:n)`` so both volume and onset stay visible. This is what keeps
    per-frame spam — even interleaved with other messages — from drowning a fresh, genuinely-new line
    or blowing the caller's context budget."""
    groups: dict = {}
    for rec in _split_records(lines):
        m = HEADER_RE.match(rec[0])
        key = (m.group(3), m.group(4), tuple(rec[1:])) if m else ("", rec[0], tuple(rec[1:]))
        g = groups.pop(key, None)
        if g is None:
            g = {"count": 0, "first_frame": m.group(1) if m else None, "rec": rec}
        g["count"] += 1
        g["rec"] = rec
        groups[key] = g
    flat: list[str] = []
    for g in groups.values():
        rec = g["rec"]
        if g["count"] > 1:
            onset = f", first F:{g['first_frame']}" if g["first_frame"] is not None else ""
            flat.append(f"{rec[0]}  (×{g['count']}{onset})")
            flat.extend(rec[1:])
        else:
            flat.extend(rec)
    return flat

def _compile_errors(dir_path: str) -> list[str]:
    """The orchestrator's compile-error summary (its own file, separate from Unity's console)."""
    try:
        text = (_ss(dir_path) / ".mcp_logs" / "orchestrator.log").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return [ln.rstrip() for ln in text.splitlines() if ln.strip()]

def _engine_compile_errors(dir_path: str) -> list[str]:
    """The engine bridge's live compile-error capture (.mcp_compile_errors.log — written on every
    failed compilation, deleted on a clean one, so its contents are always current)."""
    try:
        text = (_ss(dir_path) / ".mcp_compile_errors.log").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return [ln.rstrip() for ln in text.splitlines() if ln.strip()]

_RAW_CS_ERROR_CAP = 12

def _raw_log_compile_errors(dir_path: str) -> list[str]:
    """Fallback for editors whose engine predates the compile-error capture: distinct 'error CSxxxx'
    lines from the raw Unity -logFile. The raw log is append-only across sessions, so these may
    predate the last successful compile — callers label them as such."""
    raw = _raw_log(dir_path)
    if raw is None:
        return []
    seen: list[str] = []
    for line in _tail_lines(raw):
        if ": error CS" not in line or "_MCPExec_" in line:
            continue
        line = line.strip()
        if line not in seen:
            seen.append(line)
    if len(seen) > _RAW_CS_ERROR_CAP:
        seen = seen[-_RAW_CS_ERROR_CAP:]
    return seen

def _had_clean_compile(dir_path: str) -> bool:
    """The engine (and a clean unity.refresh()) stamp .mcp_last_clean_compile after every clean
    compilation. Its presence means an absent .mcp_compile_errors.log is a live 'no errors', so the
    raw-log fallback would only resurrect errors that predate that clean compile."""
    return (_ss(dir_path) / ".mcp_last_clean_compile").exists()

def _compile_error_section(dir_path: str, grep) -> tuple[list[str], str]:
    """(lines, source tag) for the compile-error section: orchestrator summary + engine capture,
    deduped; raw-log scan only when both are absent AND no clean compile was ever stamped for this
    editor (tagged as possibly stale)."""
    merged: list[str] = []
    for ln in _compile_errors(dir_path) + _engine_compile_errors(dir_path):
        if ln not in merged:
            merged.append(ln)
    if merged:
        return _grep(merged, grep), ""
    if _had_clean_compile(dir_path):
        return [], ""
    raw = _grep(_raw_log_compile_errors(dir_path), grep)
    if raw:
        return raw, ", from raw editor log — may predate the last successful compile"
    return [], ""

def _raw_log(dir_path: str) -> Path | None:
    """The raw Unity -logFile for this editor: streamed first, else the MCP build server's."""
    ss = _ss(dir_path)
    for c in (ss / ".mcp_rawstream_editor.log", ss / ".mcp_editor.log"):
        if c.exists():
            return c
    return None

def _disk_targets(root: str, target: str) -> list[dict]:
    """Editors derivable purely from on-disk dirs, ignoring liveness — the fallback when discovery is
    empty (editor still booting or already crashed). Primary = project root; clones = Library/VP/* dirs."""
    out: list[dict] = [{"index": 0, "role": "primary", "vpId": None, "dir": root, "pid": None,
                        "state": "?", "isPlaying": None, "isCompiling": None, "isBatchMode": None}]
    vp = Path(root) / "Library" / "VP"
    if vp.is_dir():
        for d in sorted(vp.iterdir(), key=lambda p: p.name):
            if d.is_dir():
                out.append({"index": len(out), "role": "clone", "vpId": d.name, "dir": str(d),
                            "pid": None, "state": "?", "isPlaying": None, "isCompiling": None,
                            "isBatchMode": None})
    return select_targets(out, target)

def _gather_player(p: dict, source: str, severity: str, lines: int, live: bool, collapse: bool, grep=None) -> str:
    label = player_label(p) + ("" if live else "  · OFFLINE (reading disk — booting or crashed)")
    parts = [f"=== {label} ==="]
    gtag = f", grep=/{grep.pattern}/" if grep is not None else ""
    empty = f"(no lines matching /{grep.pattern}/)" if grep is not None else "(empty)"

    if source in ("auto", "compile"):
        errs, err_tag = _compile_error_section(p["dir"], grep)
        if errs:
            parts.append(f"-- compile errors ({len(errs)}{err_tag}{gtag}) --")
            parts.extend(errs)
        elif source == "compile":
            parts.append("(no compile errors)" if grep is None else f"(no compile errors matching /{grep.pattern}/)")

    console_present = False
    console_body: list[str] = []
    if source in ("auto", "console"):
        console = _ss(p["dir"]) / ".mcp_logs" / "console.log"
        try:
            console_on_disk = console.exists()
        except OSError as e:
            console_on_disk = False
            console_body = [f"(console.log unreadable: {e.strerror or e} — the logs folder is "
                            "wedged mid-delete; it clears when whatever holds it lets go)"]
        if console_on_disk:
            raw_recs = _tail_lines(console)
            all_recs = _drop_engine_noise(raw_recs)
            recs = _filter_structured(all_recs, severity)
            collapsed = _collapse_records(recs) if collapse else recs
            console_present = bool(raw_recs)
            console_body = _clip_records(_grep_records(collapsed, grep), lines)
        if console_body:
            parts.append(f"-- console ({len(console_body)} ln, severity={severity}{gtag}) --")
            parts.extend(console_body)
        elif console_present:
            mtag = f" matching /{grep.pattern}/" if grep is not None else ""
            stag = f" at severity '{severity}'" if severity != "all" else ""
            parts.append(f"(console: 0 lines{stag}{mtag})")
        elif source == "console":
            parts.append("(console empty or absent)" if grep is None else f"(console has no lines matching /{grep.pattern}/)")

    if source == "editor" or (source == "auto" and not console_present):
        raw = _raw_log(p["dir"])
        if raw:
            body = _clip(_grep(_tail_lines(raw), grep), lines)
            stag = "; raw log carries no severity — filter not applied" if severity != "all" else ""
            parts.append(f"-- {raw.name} ({len(body)} ln{stag}{gtag}) --")
            parts.extend(body or [empty])
        elif source == "editor":
            parts.append("(no editor/startup log)")

    if len(parts) == 1:
        parts.append("(no logs on disk yet)" if grep is None else f"(no lines match /{grep.pattern}/)")
    return "\n".join(parts)

async def _flush_tag_logs(root: Path, timeout_seconds: float = 5.0) -> None:
    """Best-effort: ask each live editor for this project to flush SaturaLog so its tag files are current
    on disk before we read them. SaturaLog's tag writers otherwise flush only every 256 lines or on Play
    exit, so a mid-play read can lag. No live editor, or any failure/timeout -> silently skip; we still
    read whatever is already on disk."""
    try:
        if not discover_players(str(root)):
            return
        enq = await enqueue(root, "flushLogs", {})
        if enq.get("error"):
            return
        await await_command(root, enq["cmdId"], kind="flushLogs", timeout_seconds=timeout_seconds)
    except Exception:
        return

async def _tag_logs(root: str, player: str, tag: str, lines: int, grep: str) -> str:
    if not (Path(root) / "Assets").is_dir():
        return f"ERROR: Not a Unity project: {root}"
    live = discover_players(root)
    sel = select_targets(live, player) if live else _disk_targets(root, player)
    if not sel:
        return f"No editor matched player '{player}'."
    out = []
    for p in sel:
        await _flush_tag_logs(Path(p["dir"]))
        text = await asyncio.to_thread(tag_logs, p["dir"], tag, max(0, lines or 0), grep)
        out.append(text if len(sel) == 1 else f"=== {player_label(p)} ===\n{text}")
    return "\n\n".join(out)

@tool_guard
async def unity_logs(
    source: Annotated[Literal["auto", "console", "compile", "editor", "tags"], Field(description="Which log, see the table above.")] = "auto",
    severity: Annotated[Literal["all", "log", "warn", "error"], Field(description="Filters the console only.")] = "all",
    grep: Annotated[str, Field(description="Python regex kept per line, case-sensitive. Prefix (?i) to ignore case.")] = "",
    lines: Annotated[int, Field(description="The last N lines per section. 0 = all.")] = 400,
    player: Annotated[str, Field(description="Which editor: all, primary, clones, a vpId or a 1-based player number.")] = "all",
    collapse: Annotated[bool, Field(description="Fold repeated console lines into one.")] = True,
    tag: Annotated[str, Field(description='source="tags" only: the tag to read. Empty lists the tags.')] = "",
    project_root: ProjectRoot = "",
) -> str:
    root = _root(project_root)
    severity = (severity or "all").lower()
    if severity not in ("all", "log", "warn", "error"):
        return "ERROR: severity must be one of: all, log, warn, error."
    source = (source or "auto").lower()
    if source not in ("auto", "console", "editor", "compile", "tags"):
        return "ERROR: source must be one of: auto, console, editor, compile, tags."
    if tag and source == "auto":
        source = "tags"
    if tag and source != "tags":
        return f"ERROR: unity.logs(): tag reads a SaturaLog tag, so leave source out or pass source: 'tags', not {source!r}."
    pat = None
    if grep:
        try:
            pat = re.compile(grep)
        except re.error as e:
            return f"ERROR: invalid grep regex {grep!r}: {e}"
    if source == "tags":
        return await _tag_logs(root, player, tag, lines, grep)

    def work() -> str:
        live_players = discover_players(root)
        sel = select_targets(live_players, player) if live_players else []
        live = bool(sel)
        if not sel:
            sel = _disk_targets(root, player)
        if not sel:
            return f"No editor matched player '{player}' (none live, none on disk)."
        return "\n\n".join(_gather_player(p, source, severity, lines, live, collapse, pat) for p in sel)

    return await asyncio.to_thread(work)
