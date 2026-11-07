import re
import time
from pathlib import Path

_MCP_LOGS_DIR = ".mcp_logs"


def _log_dirs(project_root: str) -> list[tuple[str, Path]]:
    root = Path(project_root)
    candidates = [
        ("editor", root / ".sspace" / _MCP_LOGS_DIR),
        ("main", root / _MCP_LOGS_DIR),
    ]
    return [(label, d) for label, d in candidates if d.is_dir()]


def _age_note(path: Path) -> str:
    try:
        secs = max(0.0, time.time() - path.stat().st_mtime)
    except OSError:
        return ""
    if secs < 120:
        return "just now"
    if secs < 7200:
        return f"{secs / 60:.0f}m ago"
    if secs < 172800:
        return f"{secs / 3600:.1f}h ago"
    return f"{secs / 86400:.1f}d ago"


_MIRROR_TAGS = {
    "_log": "every console log line",
    "_warn": "every console warning",
    "_error": "every console error, with its first stack line",
    "_unity": "Unity's own log",
}


def _console_file(stem: str) -> bool:
    return stem == "console" or re.fullmatch(r"console\.prev\d+", stem) is not None


def tag_logs(project_root: str, tag: str = "", tail: int = 0, grep: str = "") -> str:
    """List available tags (tag="") or read a specific log (tag="x"). Use tail>0 for last N lines.

    grep is a Python regex applied per-line in read mode BEFORE tail (so tail returns the last N
    matches). Ignored in list mode. Invalid regex returns an error string."""
    pat = None
    if grep:
        try:
            pat = re.compile(grep)
        except re.error as e:
            return f"ERROR: invalid grep regex {grep!r}: {e}"
    dirs = _log_dirs(project_root)
    if not dirs:
        if not tag:
            return "No tag logs yet. SaturaLog.Log(tag, message) writes them."
        return f"Tag '{tag}' not found. No tag logs exist yet."

    multi_dir = len(dirs) > 1

    if not tag:
        out = []
        for label, log_dir in dirs:
            files = sorted((f for f in log_dir.glob("*.log") if not _console_file(f.stem)),
                           key=lambda f: (f.stem in _MIRROR_TAGS, f.stem))
            if not files:
                continue
            header = f"[{label}] " if multi_dir else ""
            own = sum(1 for f in files if f.stem not in _MIRROR_TAGS)
            mirrors = ", plus the console mirrors" if own < len(files) else ""
            out.append(f"{header}No SaturaLog tags yet. Console mirrors:" if own == 0 else
                       f"{header}Tag logs ({own} tag{'' if own == 1 else 's'}{mirrors}):")
            for f in files:
                try:
                    size = f.stat().st_size
                    line_count = sum(1 for _ in f.open(encoding="utf-8", errors="replace"))
                except OSError as e:
                    out.append(f"  {f.stem}: unreadable ({e.strerror or e}) — deleted or locked, retry in a moment")
                    continue
                if size < 1024:
                    sz = f"{size}B"
                elif size < 1024 * 1024:
                    sz = f"{size / 1024:.1f}KB"
                else:
                    sz = f"{size / (1024 * 1024):.1f}MB"
                age = _age_note(f)
                mirror = f" — {_MIRROR_TAGS[f.stem]}" if f.stem in _MIRROR_TAGS else ""
                out.append(f"  {f.stem}: {line_count} lines ({sz}{', ' + age if age else ''}){mirror}")
        return "\n".join(out) if out else "No tag logs yet. SaturaLog.Log(tag, message) writes them."

    sections = []
    for label, log_dir in dirs:
        log_file = log_dir / f"{tag}.log"
        try:
            present = log_file.exists()
        except OSError:
            present = True
        if not present:
            continue
        try:
            lines = log_file.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as e:
            sections.append((label, [f"(log unreadable: {e.strerror or e} — deleted or locked, retry in a moment)"],
                             _age_note(log_file)))
            continue
        if pat is not None:
            lines = [l for l in lines if pat.search(l)]
        if tail > 0:
            lines = lines[-tail:]
        sections.append((label, lines, _age_note(log_file)))

    if not sections:
        available = _available_tags(project_root)
        if available:
            return f"Tag '{tag}' not found. Available: {', '.join(available)}"
        return f"Tag '{tag}' not found. No tag logs exist yet."

    if tag != "_unity":
        for label, log_dir in dirs:
            unity_file = log_dir / "_unity.log"
            try:
                if not unity_file.exists():
                    continue
            except OSError:
                continue
            try:
                unity_text = unity_file.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            error_lines = [
                l for l in unity_text.splitlines()
                if "] [ERR] " in l or "] [EXC] " in l or "] [WARN] " in l or "] [ASSERT] " in l
            ]
            if pat is not None:
                error_lines = [l for l in error_lines if pat.search(l)]
            if error_lines:
                sections.append((f"{label}/_unity", error_lines, _age_note(unity_file)))

    if len(sections) == 1 and not multi_dir:
        body = sections[0][1]
        if body:
            return "\n".join(body)
        return f"(no lines match /{grep}/)" if pat is not None else "(empty log)"

    out = []
    for label, lines, age in sections:
        note = f", last write {age}" if age else ""
        out.append(f"[{label}] ({len(lines)} lines{note}):")
        out.extend(lines)
        out.append("")
    return "\n".join(out).rstrip()


def _available_tags(project_root: str) -> list[str]:
    tags = set()
    for _, log_dir in _log_dirs(project_root):
        tags.update(f.stem for f in log_dir.glob("*.log") if not _console_file(f.stem))
    return sorted(tags)
