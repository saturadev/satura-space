import os
import re
import textwrap
from pathlib import Path

from . import source_cache as sc

_CALLER_CAP = 12
_DEF_CAP = 8
_SKIP_DIRS = {"Library", "Temp", "Logs", "obj", "PackageCache"}
_MESSAGE_RE = re.compile(r"^(Awake|Start|Update|FixedUpdate|LateUpdate|Reset|OnValidate|OnGUI|On[A-Z]\w*)$")
_DECL_MODS = r"(?:(?:public|private|protected|internal|static|virtual|override|async|abstract|sealed|new|extern|unsafe|partial|readonly)\s+)*"


def _cs_files(root: Path):
    for top in ("Assets", "Packages"):
        base = root / top
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base, followlinks=True):
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and not d.endswith("~") and d not in _SKIP_DIRS
                           and not d.startswith("com.saturaspace.")]
            for f in filenames:
                if f.endswith(".cs"):
                    yield Path(dirpath) / f


def _load(root: Path):
    out = []
    for path in _cs_files(root):
        try:
            text = sc._read_source(path)
        except OSError:
            continue
        out.append((path.relative_to(root).as_posix(), text))
    return out


def _type_decls(files, tname: str):
    rx = re.compile(r"\b(class|struct|interface|enum|record)\s+" + re.escape(tname) + r"\b")
    hits = []
    for rel, text in files:
        if tname not in text:
            continue
        neutral = sc.neutralize(text)
        for m in rx.finditer(neutral):
            starts = sc.line_starts(text)
            line = sc.line_of(starts, m.start())
            hits.append((rel, text, neutral, starts, sc.offset_of_line(starts, line), line, m.group(1)))
    return hits


_ATTR_RE = re.compile(r"^\s*(?:\[[^\]]*\]\s*)+")


def _member_decls(type_hits, member: str):
    out = []
    rx = re.compile(r"\b" + re.escape(member) + r"\b")
    for rel, text, neutral, starts, off, _line, _kind in type_hits:
        for m in sc.find_members_in_type(text, neutral, off, member):
            at = rx.search(neutral, m["start"])
            line = sc.line_of(starts, at.start() if at else m["start"])
            out.append((rel, line, dict(m, sig=_ATTR_RE.sub("", m["sig"])), text))
    return out


def _loose_method_decls(files, name: str):
    rx = re.compile(r"^[ \t]*" + _DECL_MODS + r"[\w<>\[\],.?]+[ \t]+" + re.escape(name) + r"[ \t]*(?:<[^>\n]*>)?[ \t]*\(", re.M)
    out = []
    for rel, text in files:
        if name not in text:
            continue
        neutral = sc.neutralize(text)
        starts = None
        for m in rx.finditer(neutral):
            starts = starts or sc.line_starts(text)
            line = sc.line_of(starts, m.start())
            out.append((rel, line, text.splitlines()[line - 1].strip()))
    return out


def _callers(files, member: str, skip: set, method: bool, home: set, private: bool):
    name = re.escape(member)
    if method:
        bare = re.compile(r"(?<![\w.])" + name + r"\s*(?:<[^>\n]*>)?\s*\(|[=,(]\s*(?:this\.)?" + name + r"\s*[;,)]")
        dotted = re.compile(r"\.\s*" + name + r"\s*(?:<[^>\n]*>)?\s*\(|\bthis\.\s*" + name + r"\b")
    else:
        bare = re.compile(r"(?<![\w.])" + name + r"\s*[-+*/]?=[^=]|(?<![\w.])" + name + r"\b")
        dotted = re.compile(r"\.\s*" + name + r"\b")
    decl = re.compile(r"^\s*" + _DECL_MODS + r"[\w<>\[\],.?]+\s+" + re.escape(member) + r"\s*(?:<[^>\n]*>)?\s*\(")
    out = []
    for rel, text in files:
        if member not in text or private and rel not in home:
            continue
        rx = bare if rel in home else dotted
        neutral = sc.neutralize(text)
        nlines = neutral.splitlines()
        lines = text.splitlines()
        for i, ln in enumerate(nlines):
            if (rel, i + 1) in skip or not rx.search(ln) or decl.search(ln):
                continue
            out.append(f"  {rel}:{i + 1}  {lines[i].strip()[:160]}")
    return out


def lookup(root: Path, symbol: str, mode: str, max_lines: int, include_private: bool) -> str | None:
    parts = [p for p in symbol.replace("::", ".").strip().split(".") if p]
    if not parts or not (root / "Assets").is_dir():
        return None
    files = _load(root)
    tname, member, type_hits = parts[-1], None, []
    if len(parts) >= 2:
        owner = _type_decls(files, parts[-2])
        if owner and _member_decls(owner, parts[-1]):
            tname, member, type_hits = parts[-2], parts[-1], owner
    if not type_hits:
        tname, member = parts[-1], None
        type_hits = _type_decls(files, tname)
    if not type_hits and len(parts) >= 2:
        tname, member = parts[-2], parts[-1]
        type_hits = _type_decls(files, tname)
    head = f"{symbol} is in this project, not in Unity (unity.source reads Unity's own source only for Unity APIs)."
    if type_hits and member is None:
        out = [head]
        if mode == "find":
            for rel, text, neutral, starts, off, line, kind in type_hits[:_DEF_CAP]:
                ext = sc.type_extent(neutral, off)
                decl = sc._collapse(text[off:ext[0]]) if ext else text.splitlines()[line - 1].strip()
                out.append(f"  {decl}")
                out.append(f"    {rel}:{line}")
            out.append(f"→ unity.source('signatures', '{tname}') for its members, or read the file.")
            return "\n".join(out)
        body = []
        for rel, text, neutral, starts, off, line, kind in type_hits[:_DEF_CAP]:
            body.append(f"// {rel}:{line}")
            if mode == "body":
                ext = sc.type_extent(neutral, off)
                end_off = ext[1] if ext else min(len(text), off + 20000)
                body.extend(text[off:end_off + 1].splitlines())
            else:
                body.extend(sc.build_skeleton(text, neutral, off, kind, include_private))
            body.append("")
        return "\n".join([head] + _clip(body, max_lines))
    if type_hits:
        decls = _member_decls(type_hits, member)
        if not decls:
            where = ", ".join(f"{h[0]}:{h[5]}" for h in type_hits[:3])
            return (f"{tname} is in this project ({where}), but it declares no member named '{member}'. "
                    f"It may be inherited: unity.source('signatures', '{tname}') lists what it declares.")
    else:
        if len(parts) != 1:
            return None
        member = parts[0]
        loose = _loose_method_decls(files, member)
        if not loose:
            return None
        decls = None
        tname = ""
    out = [head]
    if decls is not None:
        if mode == "body":
            body = []
            for rel, line, m, text in decls[:_DEF_CAP]:
                body.append(f"// {rel}:{line}")
                begin = text.rfind("\n", 0, m["start"]) + 1
                body.extend(textwrap.dedent(text[begin:m["body_end"] + 1]).splitlines())
                body.append("")
            return "\n".join([head] + _clip(body, max_lines))
        out.append(f"Declared ({len(decls)}):")
        for rel, line, m, _text in decls[:_DEF_CAP]:
            out.append(f"  {m['sig']}")
            out.append(f"    {rel}:{line}")
        skip = {(rel, line) for rel, line, _m, _t in decls}
    else:
        out.append(f"Declared ({len(loose)}):")
        for rel, line, text in loose[:_DEF_CAP]:
            out.append(f"  {text}")
            out.append(f"    {rel}:{line}")
        skip = {(rel, line) for rel, line, _t in loose}
    if mode == "signatures":
        return "\n".join(out)
    sigs = [m["sig"] for _r, _l, m, _t in decls] if decls is not None else [t for _r, _l, t in loose]
    method = any("(" in sig for sig in sigs)
    home = {rel for rel, *_ in type_hits} if type_hits else {rel for rel, _l, _t in loose}
    private = decls is not None and not any(re.search(r"\b(public|internal|protected)\b", sig) for sig in sigs)
    calls = [] if method and _MESSAGE_RE.match(member) else _callers(files, member, skip, method, home, private)
    if method and _MESSAGE_RE.match(member):
        out.append(f"Used at: Unity calls {member} itself (a MonoBehaviour message), not your code.")
    elif calls:
        scope = ", private so only its own file" if private else ", matched by name" if len(calls) > 1 else ""
        out.append(f"Used at ({len(calls)}{scope}):")
        out.extend(calls[:_CALLER_CAP])
        if len(calls) > _CALLER_CAP:
            out.append(f"  … {len(calls) - _CALLER_CAP} more")
    else:
        out.append("Used at: nowhere else by name (Unity may call it by message name, like Update or OnTriggerEnter, or through a UnityEvent or SendMessage).")
    target = f"{tname}.{member}" if tname else member
    out.append(f"→ unity.source('body', '{target}') for the code.")
    return "\n".join(out)


def _clip(lines: list[str], max_lines: int) -> list[str]:
    if max_lines <= 0 or len(lines) <= max_lines:
        return lines
    return lines[:max_lines] + [f"… {len(lines) - max_lines} more line(s) hidden (raise maxLines)"]
