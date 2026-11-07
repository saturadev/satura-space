import json
import re
from pathlib import Path

from .input_gate import _read, _sources

GUARD = "#if UNITY_EDITOR && SATURA_SPACE"
DEFINE = "SATURA_SPACE"
TYPES = (
    "SaturaHandle", "SaturaHandles", "SaturaLog", "SaturaStaging", "SaturaScenario", "SaturaCheckException",
    "SaturaLaunch", "SaturaJson", "SaturaRemoteGamepad", "SaturaClips", "SaturaDebug", "SaturaGameClock",
    "SaturaFrameRate", "OnHotReload", "MCPTestBridge",
)
USE = re.compile(r"\busing\s+(?:static\s+)?(?:\w+\s*=\s*)?(SaturaSpace|HotReloadPrototype)\b|\b(SaturaSpace)\s*\.|\b(" + "|".join(TYPES) + r")\b")
INP = re.compile(r"(?<![\w.])Inp\s*\.")
DIRECTIVE = re.compile(r"^\s*#\s*(if|elif|else|endif)\b(.*)$")
SYMBOL = re.compile(r"!?\s*\b[A-Za-z_]\w*\b")
STRING = re.compile(r'@"(?:[^"]|"")*"|\$?"(?:[^"\\\n]|\\.)*"|\'(?:[^\'\\\n]|\\.)\'')
SHOWN = 12
CACHE_FILE = ".satura_guard_scan.json"

_cache: dict[str, dict[str, tuple[float, int, list[str]]]] = {}


def _sure(cond: str) -> set[str]:
    cond = re.sub(r"//.*", "", cond).strip()
    if "||" in cond or re.search(r"!\s*\(", cond):
        return set()
    out = set()
    for m in SYMBOL.finditer(cond.replace("(", " ").replace(")", " ")):
        tok = m.group(0).replace(" ", "")
        if not tok.startswith("!") and tok not in ("true", "false"):
            out.add(tok)
    return out


def _editor_only(rel: str, root: Path) -> bool:
    parts = rel.split("/")
    if "Editor" in parts[:-1]:
        return True
    d = (root / rel).parent
    top = root.resolve()
    while True:
        for asmdef in d.glob("*.asmdef"):
            try:
                data = json.loads(asmdef.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return False
            return data.get("includePlatforms") == ["Editor"]
        if d.resolve() == top or d.parent == d:
            return False
        d = d.parent


def _what(m: re.Match) -> str:
    if m.group(1):
        return f"using {m.group(1)};"
    if m.group(2):
        return "SaturaSpace."
    return m.group(3)


def scan_cs(rel: str, text: str, editor_only: bool = False) -> list[str]:
    out = []
    frames: list[set[str]] = []
    block = False
    inp = bool(re.search(r"\busing\s+SaturaSpace\s*;", text))
    for i, line in enumerate(text.splitlines(), 1):
        d = DIRECTIVE.match(line)
        if d and not block:
            kind, cond = d.group(1), d.group(2)
            if kind == "if":
                frames.append(_sure(cond))
            elif kind == "elif" and frames:
                frames[-1] = _sure(cond)
            elif kind == "else" and frames:
                frames[-1] = set()
            elif kind == "endif" and frames:
                frames.pop()
            continue
        code = line
        if block:
            end = code.find("*/")
            if end < 0:
                continue
            code = code[end + 2:]
            block = False
        code = STRING.sub('""', code)
        code = re.sub(r"/\*.*?\*/", "", code)
        start = code.find("/*")
        if start >= 0:
            code = code[:start]
            block = True
        code = code.split("//", 1)[0]
        sure = set().union(*frames) if frames else set()
        if DEFINE in sure and ("UNITY_EDITOR" in sure or editor_only):
            continue
        hits = [_what(m) for m in USE.finditer(code)]
        if inp and INP.search(code):
            hits.append("Inp")
        if not hits:
            continue
        fix = f"add UNITY_EDITOR: {GUARD}" if DEFINE in sure else f"wrap it in {GUARD} ... #endif"
        if "SaturaStaging" in hits and re.search(r":\s*(SaturaSpace\.)?SaturaStaging\b", code):
            fix = "derive from StagingBase, the alias staging.md shows"
        seen = []
        for h in hits:
            if h not in seen:
                seen.append(h)
        out.append(f"{rel}:{i}: {', '.join(seen)} → {fix}")
    return out


def _load(root: Path) -> dict | None:
    try:
        data = json.loads((root / ".sspace" / CACHE_FILE).read_text(encoding="utf-8"))
        return {k: (v[0], v[1], list(v[2])) for k, v in data.items()}
    except (OSError, ValueError, TypeError, IndexError, AttributeError):
        return None


def _save(root: Path, cur: dict) -> None:
    try:
        d = root / ".sspace"
        if d.is_dir():
            (d / CACHE_FILE).write_text(json.dumps(cur), encoding="utf-8")
    except OSError:
        pass


def guard_findings(root) -> tuple[list[str], list[str]]:
    root = Path(root)
    key = str(root.resolve())
    prev = _cache.get(key)
    if prev is None:
        prev = _load(root)
    cur: dict[str, tuple[float, int, list[str]]] = {}
    fresh: list[str] = []
    known: list[str] = []
    for path in _sources(root):
        if path.suffix != ".cs":
            continue
        try:
            st = path.stat()
        except OSError:
            continue
        rel = path.relative_to(root).as_posix()
        old = (prev or {}).get(rel)
        if old and old[0] == st.st_mtime and old[1] == st.st_size:
            cur[rel] = old
            known.extend(old[2])
            continue
        text = _read(path) or ""
        found = scan_cs(rel, text, _editor_only(rel, root)) if ("Satura" in text or "Inp" in text or "HotReloadPrototype" in text or "MCPTestBridge" in text) else []
        cur[rel] = (st.st_mtime, st.st_size, found)
        (fresh if prev is not None else known).extend(found)
    _cache[key] = cur
    _save(root, cur)
    if prev is None:
        return known, []
    return fresh, known


def _own_rsp_note(root: Path) -> str | None:
    text = _read(root / "Assets" / "csc.rsp")
    if text is None or re.search(r"^\s*[-/]d(?:efine)?:\S*\bSATURA_SPACE\b", text, re.M):
        return None
    return (
        "Assets/csc.rsp is the project's own and doesn't define SATURA_SPACE, so Satura Space left it alone and "
        f"game code inside {GUARD} is compiled out: its handles and logs don't exist. Never add -define:SATURA_SPACE to "
        "it: a committed define breaks plain Unity for everyone without Satura Space. Ask the user to move its options "
        "into Player Settings (Allow 'unsafe' Code for -unsafe) and delete the file; Satura Space then writes its own."
    )


def guard_note(root) -> str | None:
    root = Path(root)
    lines = []
    rsp = _own_rsp_note(root)
    if rsp:
        lines.append(rsp)
    try:
        fresh, known = guard_findings(root)
    except Exception:
        fresh, known = [], []
    if fresh:
        shown = fresh[:SHOWN]
        lines.append(
            "Satura code outside the guard: the game must compile and play in plain Unity without Satura Space, "
            f"and player builds never get the engine, so every Satura Space use in game code goes inside {GUARD} ... #endif "
            "(handles.md, staging.md):"
        )
        lines += [f"  {s}" for s in shown]
        if len(fresh) > len(shown):
            lines.append(f"  and {len(fresh) - len(shown)} more")
        if known:
            lines.append(f"  ({len(known)} earlier finding(s) in files that haven't changed are not repeated)")
    return "\n".join(lines) or None
