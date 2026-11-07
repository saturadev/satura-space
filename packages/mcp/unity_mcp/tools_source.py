"""Unity engine reference tools — ground truth for the Unity API, version-pinned to the project.

Two read-only tools over Unity-Technologies/UnityCsReference (the engine's real C# source) and
docs.unity3d.com ScriptReference. The source ref is pinned to the project's exact Unity version
(release tag, falling back to the stream branch), so signatures/overloads/[Obsolete] answers match
what actually compiles in this project — not what the model remembers.

Token discipline is the design: unity.source() escalates 'find' (locations + signatures) →
'signatures' (a type's public API skeleton, no bodies) → 'body' (one member's implementation) →
'grep' (last resort, capped). unity.docs() adds the prose the source lacks (UnityCsReference carries
no XML doc comments): main-thread constraints, edit-mode behavior, null returns.

UnityCsReference is licensed reference-only — read it to get APIs right; never copy engine code
into the user's project.
"""
import asyncio
import difflib
import re
from pathlib import Path

from typing import Annotated, Literal

from pydantic import Field

from .helpers import path_within, resolve_root, tool_guard
from .instances import _project_version
from . import project_source
from . import source_cache as sc

_FIND_TYPE_CAP = 10
_FIND_MEMBER_CAP = 20
_PARTIAL_FILE_CAP = 6
_DOC_CHAR_CAP = 14000

_LICENSE_NOTE = "License: UnityCsReference is reference-only — never copy engine code into the project."


def _resolved_version(project_root: str, version: str) -> str:
    if version.strip():
        return version.strip()
    return _project_version(Path(resolve_root(project_root)))


def _prepare(project_root: str, version: str):
    v = _resolved_version(project_root, version)
    if not v:
        raise LookupError(
            "No Unity version known: pass {version: '6000.0.32f1'} (or a stream like '6000.0'), "
            "or run it in a project whose ProjectSettings/ProjectVersion.txt exists."
        )
    return sc.ensure_source(v)


def _load(root: Path, rel: str):
    text = sc._read_source(root / rel)
    return text, sc.neutralize(text), sc.line_starts(text)


def _clip(lines: list[str], max_lines: int, what: str = "line") -> list[str]:
    if max_lines <= 0 or len(lines) <= max_lines:
        return lines
    hidden = len(lines) - max_lines
    return lines[:max_lines] + [f"… {hidden} more {what}(s) hidden (raise maxLines)"]


def _project(project_root: str, symbol: str, mode: str, max_lines: int = 250, include_private: bool = False) -> str | None:
    try:
        return project_source.lookup(Path(resolve_root(project_root)), symbol, mode, max_lines, include_private)
    except (OSError, ValueError):
        return None


def _find_impl(symbol: str, project_root: str, version: str) -> str:
    root, ref, index, notes = _prepare(project_root, version)
    kind, tname, entries, member_or_sugg = sc.resolve_symbol(index, symbol)
    out = list(notes)
    if kind == "none" or kind == "member" and not _has_member(root, entries, member_or_sugg):
        mine = _project(project_root, symbol, "find")
        if mine:
            return "\n".join(out + [mine])
    if kind == "none":
        sugg = member_or_sugg or []
        msg = f"No type matched '{symbol}' in UnityCsReference {ref} or in this project's scripts."
        if sugg:
            msg += " Close matches: " + ", ".join(sugg)
        msg += "\nTip: unity.source('grep', pattern) can search free-text if the name is uncertain."
        return "\n".join(out + [msg])
    if kind == "type":
        out.append(f"{tname} — {len(entries)} definition(s) [UnityCsReference {ref}]")
        for rel, line, tkind, ns in entries[:_FIND_TYPE_CAP]:
            try:
                text, neutral, starts = _load(root, rel)
                off = sc.offset_of_line(starts, line)
                ext = sc.type_extent(neutral, off)
                decl = sc._collapse(text[off:ext[0]]) if ext else sc._collapse(text[off:off + 200])
            except OSError:
                decl = f"{tkind} {tname}"
            out.append(f"  {decl}" + (f" — namespace {ns}" if ns else ""))
            out.append(f"    {rel}:{line}")
        if len(entries) > _FIND_TYPE_CAP:
            out.append(f"  … {len(entries) - _FIND_TYPE_CAP} more definition(s)")
        out.append(f"→ unity.source('signatures', '{tname}') for the full public API skeleton.")
        return "\n".join(out)
    member = member_or_sugg
    shown = 0
    hits: list[str] = []
    for rel, line, tkind, ns in entries:
        if shown >= _FIND_MEMBER_CAP:
            break
        try:
            text, neutral, starts = _load(root, rel)
        except OSError:
            continue
        off = sc.offset_of_line(starts, line)
        for m in sc.find_members_in_type(text, neutral, off, member):
            hits.append(f"  {m['sig']}")
            hits.append(f"    {rel}:{sc.line_of(starts, m['start'])}")
            shown += 1
            if shown >= _FIND_MEMBER_CAP:
                break
    if not hits:
        out.append(f"{tname} found, but no direct member named '{member}' [UnityCsReference {ref}].")
        out.append(f"→ unity.source('signatures', '{tname}') to see the type's actual API "
                   "(the member may live on a base type or a nested type).")
        return "\n".join(out)
    out.append(f"{tname}.{member} — {shown} declaration(s) [UnityCsReference {ref}]")
    out.extend(hits)
    out.append(f"→ unity.source('body', '{tname}.{member}') for the implementation.")
    return "\n".join(out)


def _has_member(root: Path, entries, member: str) -> bool:
    for rel, line, _tkind, _ns in entries:
        try:
            text, neutral, starts = _load(root, rel)
        except OSError:
            continue
        if sc.find_members_in_type(text, neutral, sc.offset_of_line(starts, line), member):
            return True
    return False


def _read_path_impl(root: Path, ref: str, notes: list[str], path: str,
                    start_line: int, end_line: int, max_lines: int) -> str:
    rel = path.replace("\\", "/").lstrip("/")
    target = (root / rel).resolve()
    if not path_within(str(target), str(root)):
        return f"ERROR: path escapes the source tree: {path}"
    if not target.is_file():
        return f"ERROR: no such file in UnityCsReference {ref}: {rel}"
    lines = sc._read_source(target).splitlines()
    lo = max(1, start_line or 1)
    hi = min(len(lines), end_line or (lo + max_lines - 1))
    hi = min(hi, lo + max_lines - 1)
    body = [f"{rel}:{lo}-{hi} of {len(lines)} [UnityCsReference {ref}]"]
    body.extend(f"{n:>5}  {lines[n - 1]}" for n in range(lo, hi + 1))
    return "\n".join(notes + body)


def _read_impl(symbol: str, path: str, start_line: int, end_line: int, mode: str,
               include_private: bool, max_lines: int, project_root: str, version: str) -> str:
    root, ref, index, notes = _prepare(project_root, version)
    if path:
        return _read_path_impl(root, ref, notes, path, start_line, end_line, max_lines)
    kind, tname, entries, member_or_sugg = sc.resolve_symbol(index, symbol)
    out = list(notes)
    if kind == "none" or kind == "member" and not _has_member(root, entries, member_or_sugg):
        mine = _project(project_root, symbol, mode, max_lines, include_private)
        if mine:
            return "\n".join(out + [mine])
    if kind == "none":
        sugg = member_or_sugg or []
        msg = f"No type matched '{symbol}' in UnityCsReference {ref} or in this project's scripts."
        if sugg:
            msg += " Close matches: " + ", ".join(sugg)
        return "\n".join(out + [msg])
    if kind == "type":
        body: list[str] = []
        for rel, line, tkind, ns in entries[:_PARTIAL_FILE_CAP]:
            try:
                text, neutral, starts = _load(root, rel)
            except OSError:
                continue
            off = sc.offset_of_line(starts, line)
            body.append(f"// {rel}:{line}" + (f" — namespace {ns}" if ns else ""))
            if mode == "body":
                ext = sc.type_extent(neutral, off)
                end_off = ext[1] if ext else min(len(text), off + 20000)
                body.extend(text[off:end_off + 1].splitlines())
            else:
                body.extend(sc.build_skeleton(text, neutral, off, tkind, include_private))
            body.append("")
        if len(entries) > _PARTIAL_FILE_CAP:
            body.append(f"… {len(entries) - _PARTIAL_FILE_CAP} more partial definition(s) — unity.source('find', '{tname}') lists them all.")
        return "\n".join(out + _clip(body, max_lines))
    member = member_or_sugg
    body = []
    for rel, line, tkind, ns in entries:
        try:
            text, neutral, starts = _load(root, rel)
        except OSError:
            continue
        off = sc.offset_of_line(starts, line)
        for m in sc.find_members_in_type(text, neutral, off, member):
            at = sc.line_of(starts, m["start"])
            if mode == "body":
                body.append(f"// {rel}:{at}")
                body.extend(text[m["start"]:m["body_end"] + 1].splitlines())
                body.append("")
            else:
                body.append(f"{m['sig']}    // {rel}:{at}")
    if not body:
        return "\n".join(out + [
            f"{tname} found, but no direct member named '{member}' [UnityCsReference {ref}].",
            f"→ unity.source('signatures', '{tname}') to see the type's actual API.",
        ])
    return "\n".join(out + _clip(body, max_lines))


def _grep_impl(pattern: str, glob: str, max_matches: int, context: int,
               project_root: str, version: str) -> str:
    rx = re.compile(pattern)
    root, ref, _, notes = _prepare(project_root, version)
    blocks, truncated = sc.grep_source(root, rx, glob, max_matches, context)
    out = list(notes)
    scope = f" glob='{glob}'" if glob else ""
    out.append(f"{len(blocks)} match(es) for /{pattern}/{scope} [UnityCsReference {ref}]"
               + (" — TRUNCATED, refine the pattern or glob" if truncated else ""))
    out.extend(blocks)
    return "\n\n".join(out)


def _docs_impl(api: str, project_root: str, version: str) -> str:
    explicit = version.strip()
    v = _resolved_version(project_root, version)
    if explicit and explicit.lower() != "master" and not sc.doc_stream(explicit):
        raise LookupError(
            f"invalid version {explicit!r} — pass a real Unity release ('6000.0.32f1'), "
            "a stream ('6000.0'), or 'master' for the latest docs."
        )
    stream = "" if explicit.lower() == "master" else sc.doc_stream(v)
    index = sc.load_index_if_cached(v) if v else None
    parts = [p for p in api.strip().rstrip("()").split(".") if p]
    types = (index or {}).get("types", {})
    if index and parts and not any(p in types for p in parts[-2:]):
        mine = _project(project_root, api, "find")
        if mine:
            return mine.replace("unity.source reads Unity's own source only for Unity APIs", "unity.docs covers Unity's API only")
    pages = sc.doc_page_candidates(api, index)
    if not pages:
        return f"ERROR: cannot derive a ScriptReference page from '{api}'."
    for page in pages:
        got = sc.fetch_doc(stream, page)
        if got:
            text, url = got
            note = ""
            if stream and f"/{stream}/" not in url:
                if not sc.doc_stream_exists(stream):
                    raise LookupError(
                        f"docs.unity3d.com has no '{stream}' documentation — {v!r} does not "
                        "look like a real Unity release. Pass one ('6000.0.32f1'), a stream "
                        "('6000.0'), or omit version to use the project's."
                    )
                note = (f"\n\nNOTE: no {stream} page for this API — showing the LATEST Unity "
                        "docs, which may not match this project's Unity version.")
            if len(text) > _DOC_CHAR_CAP:
                text = text[:_DOC_CHAR_CAP] + "\n… (truncated)"
            return f"{text}{note}\n\nSource: {url}"
    tried = ", ".join(pages)
    hint = _doc_hint(api, v) if v else ""
    return (f"No ScriptReference page found for '{api}' (tried: {tried})"
            + (f" [docs {stream}]" if stream else "") + "."
            + (hint or "\nTip: unity.source('find', symbol) can pin down the exact type/namespace first."))


def _member_names(root: Path, entries) -> list[str]:
    names: list[str] = []
    for rel, line, _tkind, _ns in entries:
        try:
            text, neutral, starts = _load(root, rel)
        except OSError:
            continue
        ext = sc.type_extent(neutral, sc.offset_of_line(starts, line))
        if not ext:
            continue
        for s, t, _term, _bend in sc.members(neutral, ext[0] + 1, ext[1]):
            sig = sc._collapse(text[s:t])
            name = sc.seg_name(sig) if sig and sc._is_visible(sc._split_attrs(sig)[1]) else ""
            if name and name not in ("operator", "this") and name not in names:
                names.append(name)
    return names


def _closest(word: str, pool: list[str]) -> str:
    lower = {p.lower(): p for p in pool}
    if word.lower() in lower:
        return lower[word.lower()]
    near = difflib.get_close_matches(word.lower(), list(lower), n=1, cutoff=0.75)
    return lower[near[0]] if near else ""


def _doc_hint(api: str, version: str) -> str:
    try:
        root, _ref, index, _notes = sc.ensure_source(version)
    except (LookupError, TimeoutError, OSError):
        return ""
    parts = [p for p in api.strip().rstrip("()").replace("::", ".").split(".") if p]
    if not parts:
        return ""
    kind, tname, entries, extra = sc.resolve_symbol(index, ".".join(parts))
    if kind == "none" and len(parts) >= 2:
        k2, t2, e2, sugg = sc.resolve_symbol(index, ".".join(parts[:-1]))
        if k2 == "none" and sugg:
            k2, t2, e2, _ = sc.resolve_symbol(index, sugg[0])
        if k2 == "type":
            kind, tname, entries, extra = "member", t2, e2, parts[-1]
    if kind == "none":
        return f" Did you mean {extra[0]}?" if extra else ""
    if kind != "member":
        return ""
    match = _closest(extra, _member_names(root, entries))
    if match:
        return f" Did you mean {tname}.{match}?"
    return f"\n{tname} has no member '{extra}': unity.source('signatures', '{tname}') lists its API."


_SOURCE_MODES = ("find", "signatures", "body", "grep")


@tool_guard
async def unity_source(
    mode: Annotated[Literal["find", "signatures", "body", "grep"], Field(description="What to read, see the list above.")],
    symbol: Annotated[str, Field(description="[Namespace.]Type[.Member], e.g. 'Transform', 'Transform.SetParent', 'AI.NavMeshAgent'.")] = "",
    path: Annotated[str, Field(description="signatures, body: a .cs path inside UnityCsReference, instead of symbol.")] = "",
    pattern: Annotated[str, Field(description="grep: Python regex per line, case-sensitive. Prefix (?i) to ignore case.")] = "",
    glob: Annotated[str, Field(description="grep: path filter, fnmatch ('Modules/UIElements/*') or a plain substring. Empty = every .cs file.")] = "",
    start_line: Annotated[int, Field(description="With path: first line, 1-based.")] = 0,
    end_line: Annotated[int, Field(description="With path: last line. Default start_line + max_lines - 1.")] = 0,
    include_private: Annotated[bool, Field(description="signatures: include private and internal members.")] = False,
    max_lines: Annotated[int, Field(description="signatures, body: output cap.")] = 250,
    max_matches: Annotated[int, Field(description="grep: cap on matching lines.")] = 30,
    context: Annotated[int, Field(description="grep: lines of context around each match.")] = 2,
    project_root: Annotated[str, Field(description="The project whose Unity version picks the source. Leave empty for this project.")] = "",
    version: Annotated[str, Field(description="Override: a release ('6000.0.32f1'), a stream ('6000.0') or 'master'. Empty = the project's.")] = "",
) -> str:
    mode = (mode or "").strip().lower()
    if mode not in _SOURCE_MODES:
        return f"ERROR: Unknown mode {mode!r}. Use find, signatures, body or grep."
    if mode == "grep":
        if not pattern:
            return "ERROR: unity.source('grep', pattern) needs the regex to search for."
        try:
            re.compile(pattern)
        except re.error as e:
            return f"ERROR: invalid regex {pattern!r}: {e}"
    elif mode == "find":
        if not symbol or path:
            return "ERROR: unity.source('find', symbol) needs a symbol like 'Transform.SetParent' (a path works with signatures or body)."
    elif bool(symbol) == bool(path):
        return "ERROR: unity.source(mode, symbol) takes a symbol, or { path } instead of one, not both and not neither."
    try:
        if mode == "grep":
            return await asyncio.to_thread(_grep_impl, pattern, glob, max_matches, context, project_root, version)
        if mode == "find":
            return await asyncio.to_thread(_find_impl, symbol, project_root, version)
        return await asyncio.to_thread(_read_impl, symbol, path, start_line, end_line,
                                       mode, include_private, max_lines, project_root, version)
    except (LookupError, TimeoutError) as e:
        return f"ERROR: {e}"
    except OSError as e:
        return f"ERROR: fetching UnityCsReference failed: {e}"


@tool_guard
async def unity_docs(
    api: Annotated[str, Field(description="A type or member: 'Transform', 'Transform.SetParent', 'NavMeshAgent.destination'.")],
    project_root: Annotated[str, Field(description="The project whose Unity version picks the docs. Leave empty for this project.")] = "",
    version: Annotated[str, Field(description="Override: '6000.0.32f1', '6000.0' or 'master'. Empty = the project's.")] = "",
) -> str:
    try:
        return await asyncio.to_thread(_docs_impl, api, project_root, version)
    except (LookupError, TimeoutError) as e:
        return f"ERROR: {e}"
    except OSError as e:
        return f"ERROR: fetching docs failed: {e}"
