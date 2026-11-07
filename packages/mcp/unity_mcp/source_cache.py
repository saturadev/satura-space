"""Version-pinned UnityCsReference cache + lightweight C# reference primitives.

Acquisition: the project's exact Unity version (ProjectVersion.txt) maps to a GitHub ref of
Unity-Technologies/UnityCsReference — the release tag first (6000.0.32f1), falling back to the
stream branch (6000.0). We pull the codeload tarball (no git, no history), extract only the .cs
tree into a machine-shared cache, and build a one-shot symbol index (type name → file/line/kind/
namespace). Everything after the first download is instant and offline.

Analysis: a length-preserving "neutralizer" blanks strings/comments/preprocessor lines so a dumb
char scanner can walk brace/paren structure reliably, while display text is sliced from the
ORIGINAL source at the same offsets. On top of that sit the token-frugal primitives the tools
expose: type skeletons (public API, no bodies), per-member signature/body extraction, and a
capped grep. Docs: ScriptReference page-name candidates (dot = method, hyphen = property,
namespace variants resolved through the index) plus an HTML→text reducer, disk-cached per stream.
"""
import bisect
import difflib
import fnmatch
import json
import os
import re
import shutil
import ssl
import sys
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from html.parser import HTMLParser
from pathlib import Path

from .file_lock import _try_lock, _unlock

_REPO = "Unity-Technologies/UnityCsReference"
_FULL_VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.\d+[abfpx]\d+$")
_KEEP_REFS = 3
_PRUNE_GRACE_SECS = 3600.0
_LOCK_TIMEOUT_SECS = 1200.0
_MAX_MEMBERS_PER_TYPE = 5000

_index_cache: dict[str, dict] = {}


def cache_root() -> Path:
    env = os.environ.get("SATURA_UNITY_SRC_CACHE")
    if env:
        return Path(env).expanduser()
    home = Path.home()
    if sys.platform == "darwin":
        base = home / "Library" / "Caches"
    elif sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", str(home / "AppData" / "Local")))
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME", str(home / ".cache")))
    return base / "satura-space" / "unity-reference"


def _src_root() -> Path:
    return cache_root() / "src"


def _safe_ref(ref: str) -> str:
    return ref.replace("/", "_")


def src_dir(ref: str) -> Path:
    return _src_root() / _safe_ref(ref)


def index_path(ref: str) -> Path:
    return _src_root() / f"{_safe_ref(ref)}.index.json"


@contextmanager
def cache_lock(timeout: float = _LOCK_TIMEOUT_SECS):
    root = cache_root()
    root.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(root / ".lock"), os.O_RDWR | os.O_CREAT, 0o644)
    acquired = False
    deadline = time.monotonic() + timeout
    try:
        while True:
            if _try_lock(fd):
                acquired = True
                break
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    "Timed out waiting for the Unity source cache lock — another agent is "
                    "probably still downloading UnityCsReference. Retry shortly."
                )
            time.sleep(0.5)
        yield
    finally:
        if acquired:
            _unlock(fd)
        os.close(fd)


def _atomic_write_text(path: Path, text: str) -> None:
    """Publish via tempfile + rename, tolerating a concurrent publisher.

    Two processes can race to publish the same index (ensure_source under cache_lock vs the
    deliberately lock-free load_index_if_cached, both cold): on Windows the losing os.replace hits a
    sharing violation (WinError 32). The content is deterministic per path, so after a few retries an
    already-published destination counts as success; the raced write is simply dropped."""
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    try:
        for _ in range(5):
            try:
                os.replace(tmp, path)
                return
            except OSError:
                time.sleep(0.2)
        if path.exists():
            return
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def doc_stream(version: str) -> str:
    v = (version or "").strip()
    m = _FULL_VERSION_RE.match(v)
    if m:
        return f"{m.group(1)}.{m.group(2)}"
    if re.match(r"^\d+\.\d+$", v):
        return v
    return ""


def ref_candidates(version: str) -> list[tuple[str, str]]:
    v = (version or "").strip()
    m = _FULL_VERSION_RE.match(v)
    if m:
        return [(v, "tags"), (f"{m.group(1)}.{m.group(2)}", "heads")]
    return [(v, "heads"), (v, "tags")]


def _urlopen(url: str, timeout: float = 120.0):
    req = urllib.request.Request(url, headers={"User-Agent": "satura-space-mcp"})
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.URLError as e:
        if isinstance(getattr(e, "reason", None), ssl.SSLCertVerificationError):
            try:
                import certifi
            except ImportError:
                raise
            ctx = ssl.create_default_context(cafile=certifi.where())
            return urllib.request.urlopen(req, timeout=timeout, context=ctx)
        raise


def _extract_cs(tar_path: Path, dest_dir: Path) -> None:
    import tarfile

    keep_names = {"LICENSE", "LICENSE.md", "README.md"}
    with tarfile.open(tar_path, "r:gz") as tf:
        for m in tf:
            if not m.isfile():
                continue
            parts = Path(m.name).parts
            if len(parts) < 2:
                continue
            rel = Path(*parts[1:])
            if ".." in rel.parts or rel.is_absolute():
                continue
            if rel.suffix != ".cs" and rel.name not in keep_names:
                continue
            target = dest_dir / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            src = tf.extractfile(m)
            if src is None:
                continue
            with src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)


def _fetch_ref(ref: str, kind: str) -> int | None:
    url = f"https://codeload.github.com/{_REPO}/tar.gz/refs/{kind}/{ref}"
    _src_root().mkdir(parents=True, exist_ok=True)
    tar_path = _src_root() / f".{_safe_ref(ref)}.tar.gz.part"
    tmp_dir = _src_root() / f".{_safe_ref(ref)}.extract"
    try:
        try:
            resp = _urlopen(url)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise
        total = 0
        with resp, open(tar_path, "wb") as f:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                total += len(chunk)
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)
        _extract_cs(tar_path, tmp_dir)
        dest = src_dir(ref)
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        tmp_dir.rename(dest)
        return max(1, total >> 20)
    except BaseException:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
    finally:
        tar_path.unlink(missing_ok=True)


_NS_RE = re.compile(r"^[ \t]*namespace[ \t]+([A-Za-z_][\w.]*)")
_TYPE_RE = re.compile(
    r"^[ \t]*(?:(?:public|internal|protected|private|static|abstract|sealed|partial|readonly|ref|unsafe|new)[ \t]+)*"
    r"(class|struct|interface|enum)[ \t]+([A-Za-z_]\w*)"
)


def _iter_cs(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            if name.endswith(".cs"):
                yield Path(dirpath) / name


def _read_source(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig", errors="replace")


def build_index(ref: str) -> dict:
    root = src_dir(ref)
    types: dict[str, list] = {}
    nfiles = 0
    for path in _iter_cs(root):
        rel = path.relative_to(root).as_posix()
        nfiles += 1
        try:
            text = _read_source(path)
        except OSError:
            continue
        ns = ""
        for i, line in enumerate(text.splitlines(), 1):
            ls = line.lstrip()
            if ls.startswith(("//", "*", "/*")):
                continue
            m = _NS_RE.match(line)
            if m:
                ns = m.group(1)
                continue
            m = _TYPE_RE.match(line)
            if m:
                types.setdefault(m.group(2), []).append([rel, i, m.group(1), ns])
    idx = {"ref": ref, "files": nfiles, "types": types}
    _atomic_write_text(index_path(ref), json.dumps(idx))
    return idx


def _load_index(ref: str) -> dict:
    key = str(index_path(ref))
    cached = _index_cache.get(key)
    if cached is not None:
        return cached
    try:
        idx = json.loads(index_path(ref).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        idx = build_index(ref)
    _index_cache[key] = idx
    return idx


def load_index_if_cached(version: str) -> dict | None:
    for ref, _ in ref_candidates(version):
        if src_dir(ref).is_dir():
            return _load_index(ref)
    return None


def _prune() -> None:
    root = _src_root()
    dirs = [d for d in root.iterdir() if d.is_dir() and not d.name.startswith(".")]
    dirs.sort(key=lambda d: d.stat().st_mtime, reverse=True)
    now = time.time()
    for d in dirs[_KEEP_REFS:]:
        if now - d.stat().st_mtime < _PRUNE_GRACE_SECS:
            continue
        shutil.rmtree(d, ignore_errors=True)
        (root / f"{d.name}.index.json").unlink(missing_ok=True)
        _index_cache.pop(str(root / f"{d.name}.index.json"), None)


def ensure_source(version: str) -> tuple[Path, str, dict, list[str]]:
    cands = ref_candidates(version)
    notes: list[str] = []
    with cache_lock():
        for ref, _ in cands:
            d = src_dir(ref)
            if d.is_dir():
                try:
                    os.utime(d, None)
                except OSError:
                    pass
                if ref != cands[0][0]:
                    notes.append(f"[using cached UnityCsReference {ref} for Unity {version}]")
                return d, ref, _load_index(ref), notes
        for ref, kind in cands:
            size_mb = _fetch_ref(ref, kind)
            if size_mb is None:
                continue
            if ref != cands[0][0]:
                notes.append(f"[no GitHub ref for exact version {cands[0][0]}; using {ref}]")
            notes.append(f"[downloaded UnityCsReference {ref} ({size_mb} MB) → cached at {src_dir(ref)}]")
            idx = _load_index(ref)
            _prune()
            return src_dir(ref), ref, idx, notes
    tried = ", ".join(r for r, _ in cands)
    raise LookupError(
        f"UnityCsReference has no ref matching {version!r} (tried: {tried}). "
        "Pass version= a real Unity release ('6000.0.32f1'), a stream ('6000.0'), or 'master'."
    )


_CS_NOISE_RE = re.compile(
    r'@\$?"(?:[^"]|"")*"'
    r'|\$@"(?:[^"]|"")*"'
    r'|\$?"(?:\\.|[^"\\\n])*"'
    r"|'(?:\\.|[^'\\\n])*'"
    r"|//[^\n]*"
    r"|/\*.*?\*/"
    r"|^[ \t]*#[^\n]*",
    re.S | re.M,
)


def neutralize(text: str) -> str:
    return _CS_NOISE_RE.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)


def _collapse(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def line_starts(text: str) -> list[int]:
    starts = [0]
    for m in re.finditer("\n", text):
        starts.append(m.end())
    return starts


def line_of(starts: list[int], off: int) -> int:
    return bisect.bisect_right(starts, off)


def offset_of_line(starts: list[int], line: int) -> int:
    return starts[min(max(line - 1, 0), len(starts) - 1)]


def _match_brace(s: str, i: int, end: int) -> int:
    depth = 0
    for j in range(i, end):
        c = s[j]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return j
    return end - 1


def _find_semi(s: str, i: int, end: int) -> int:
    depth = 0
    for j in range(i, end):
        c = s[j]
        if c in "{([":
            depth += 1
        elif c in "})]":
            depth -= 1
        elif c == ";" and depth <= 0:
            return j
    return end - 1


def type_extent(neutral: str, decl_off: int) -> tuple[int, int] | None:
    brace = neutral.find("{", decl_off)
    if brace == -1:
        return None
    return brace, _match_brace(neutral, brace, len(neutral))


def members(neutral: str, start: int, end: int):
    i = start
    seg_begin = None
    pdepth = 0
    yielded = 0
    while i < end and yielded < _MAX_MEMBERS_PER_TYPE:
        c = neutral[i]
        if seg_begin is None:
            if c.isspace() or c == ";":
                i += 1
                continue
            if c == "}":
                i += 1
                continue
            seg_begin = i
        if c in "([":
            pdepth += 1
        elif c in ")]":
            pdepth = max(0, pdepth - 1)
        elif pdepth == 0:
            if c == "{":
                close = _match_brace(neutral, i, end)
                yield seg_begin, i, "{", close
                yielded += 1
                i = close + 1
                seg_begin = None
                continue
            if c == ";":
                yield seg_begin, i, ";", i
                yielded += 1
                i += 1
                seg_begin = None
                continue
            if c == "}":
                yield seg_begin, i, ";", i
                yielded += 1
                i += 1
                seg_begin = None
                continue
            if c == "=":
                nxt = neutral[i + 1] if i + 1 < end else ""
                prv = neutral[i - 1] if i > start else ""
                if nxt == ">":
                    stop = _find_semi(neutral, i + 2, end)
                    yield seg_begin, i, "=>", stop
                    yielded += 1
                    i = stop + 1
                    seg_begin = None
                    continue
                if nxt == "=" or prv in "=!<>+-*/%&|^":
                    i += 2 if nxt == "=" else 1
                    continue
                stop = _find_semi(neutral, i + 1, end)
                yield seg_begin, i, "=", stop
                yielded += 1
                i = stop + 1
                seg_begin = None
                continue
        i += 1


def _split_attrs(sig: str) -> tuple[list[str], str]:
    attrs: list[str] = []
    s = sig.lstrip()
    while s.startswith("["):
        depth = 0
        j = 0
        for j, ch in enumerate(s):
            if ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
                if depth == 0:
                    break
        if depth != 0:
            break
        attrs.append(s[: j + 1])
        s = s[j + 1:].lstrip()
    return attrs, s


def _strip_generics(s: str) -> str:
    prev = None
    while prev != s:
        prev = s
        s = re.sub(r"<[^<>]*>", "", s)
    return s


def seg_name(sig: str) -> str:
    _, s = _split_attrs(sig)
    if re.search(r"\boperator\b", s):
        return "operator"
    if re.search(r"\bthis\s*\[", s):
        return "this"
    s = _strip_generics(s)
    if "(" in s:
        s = s.split("(", 1)[0]
    ids = re.findall(r"[A-Za-z_]\w*", s)
    return ids[-1] if ids else ""


def _is_visible(sig: str) -> bool:
    toks = sig.split()[:4]
    return "public" in toks or "protected" in toks


def _enum_skeleton(text: str, neutral: str, decl_off: int, pad: str) -> list[str]:
    ext = type_extent(neutral, decl_off)
    if not ext:
        return [pad + _collapse(text[decl_off: decl_off + 200]) + ";"]
    brace, close = ext
    header = _collapse(text[decl_off:brace])
    body = _collapse(text[brace + 1: close])
    if len(body) <= 120:
        return [f"{pad}{header} {{ {body} }}"]
    vals = [v.strip() for v in body.split(",") if v.strip()]
    shown = ", ".join(vals[:16])
    return [f"{pad}{header} {{ {shown}, … ({len(vals)} values) }}"]


def build_skeleton(text: str, neutral: str, decl_off: int, kind: str,
                   include_private: bool = False, depth: int = 0, max_depth: int = 3) -> list[str]:
    pad = "    " * depth
    if kind == "enum":
        return _enum_skeleton(text, neutral, decl_off, pad)
    ext = type_extent(neutral, decl_off)
    if not ext:
        return [pad + _collapse(text[decl_off: decl_off + 300]) + ";"]
    brace, close = ext
    header_attrs, header = _split_attrs(_collapse(text[decl_off:brace]))
    lines: list[str] = []
    for a in header_attrs:
        if "Obsolete" in a:
            lines.append(pad + a)
    lines.append(pad + header)
    lines.append(pad + "{")
    inner = pad + "    "
    for s, t, term, bend in members(neutral, brace + 1, close):
        attrs, sig = _split_attrs(_collapse(text[s:t]))
        if not sig:
            continue
        tm = _TYPE_RE.match(sig)
        if tm and term == "{":
            if not include_private and not _is_visible(sig):
                continue
            if depth + 1 >= max_depth:
                lines.append(f"{inner}{sig} {{ … }}")
            else:
                lines.extend(build_skeleton(text, neutral, s, tm.group(1),
                                            include_private, depth + 1, max_depth))
            continue
        if kind in ("class", "struct") and not include_private and not _is_visible(sig):
            continue
        for a in attrs:
            if "Obsolete" in a:
                lines.append(inner + a)
        has_parens = "(" in _strip_generics(sig)
        if term == ";":
            lines.append(f"{inner}{sig};")
        elif term == "=":
            val = _collapse(text[t + 1: bend])
            if 0 < len(val) <= 48:
                lines.append(f"{inner}{sig} = {val};")
            else:
                lines.append(f"{inner}{sig} = …;")
        elif term == "=>":
            lines.append(f"{inner}{sig};" if has_parens else f"{inner}{sig} {{ get; }}")
        else:
            if has_parens:
                lines.append(f"{inner}{sig};")
            else:
                body = neutral[t:bend]
                acc = "".join(
                    f" {kw};" for kw in ("get", "set", "init")
                    if re.search(rf"\b{kw}\b", body)
                ).strip() or "…"
                lines.append(f"{inner}{sig} {{ {acc} }}")
    lines.append(pad + "}")
    return lines


def find_members_in_type(text: str, neutral: str, decl_off: int, member: str) -> list[dict]:
    ext = type_extent(neutral, decl_off)
    if not ext:
        return []
    brace, close = ext
    out = []
    for s, t, term, bend in members(neutral, brace + 1, close):
        sig = _collapse(text[s:t])
        if not sig or seg_name(sig) != member:
            continue
        out.append({"sig": sig, "start": s, "term": term, "body_end": bend})
    return out


def resolve_symbol(index: dict, symbol: str):
    types = index.get("types", {})
    parts = [p for p in symbol.replace("::", ".").strip().split(".") if p]
    if not parts:
        return "none", None, [], None

    def ns_ok(entry, prefix_parts):
        if not prefix_parts:
            return True
        prefix = ".".join(prefix_parts)
        ns = entry[3]
        return ns == prefix or ns.endswith("." + prefix) or ns.startswith(prefix + ".") or prefix in ("UnityEngine", "UnityEditor")

    tname = parts[-1]
    if tname in types:
        entries = [e for e in types[tname] if ns_ok(e, parts[:-1])]
        if entries:
            return "type", tname, entries, None
    if len(parts) >= 2 and parts[-2] in types:
        entries = [e for e in types[parts[-2]] if ns_ok(e, parts[:-2])]
        if entries:
            return "member", parts[-2], entries, parts[-1]
    pool = list(types.keys())
    lower = {k.lower(): k for k in pool}
    sugg: list[str] = []
    if tname.lower() in lower:
        sugg.append(lower[tname.lower()])
    sugg.extend(m for m in difflib.get_close_matches(tname, pool, n=6, cutoff=0.75) if m not in sugg)
    return "none", None, [], sugg


def grep_source(root: Path, rx, glob: str, max_matches: int, context: int):
    blocks: list[str] = []
    count = 0
    truncated = False
    for path in _iter_cs(root):
        rel = path.relative_to(root).as_posix()
        if glob and not (fnmatch.fnmatchcase(rel, glob) or glob.lower() in rel.lower()):
            continue
        try:
            text = _read_source(path)
        except OSError:
            continue
        if not rx.search(text):
            continue
        lines = text.splitlines()
        for i, ln in enumerate(lines):
            if not rx.search(ln):
                continue
            block = []
            lo = max(0, i - context)
            hi = min(len(lines), i + context + 1)
            for j in range(lo, hi):
                mark = ":" if j == i else "-"
                block.append(f"{rel}:{j + 1}{mark} {lines[j].rstrip()}")
            blocks.append("\n".join(block))
            count += 1
            if count >= max_matches:
                truncated = True
                break
        if truncated:
            break
    return blocks, truncated


def doc_page_candidates(api: str, index: dict | None = None) -> list[str]:
    name = api.strip().rstrip("()")
    for pre in ("UnityEngine.", "UnityEditor."):
        if name.startswith(pre):
            name = name[len(pre):]
            break
    parts = [p for p in name.split(".") if p]
    if not parts:
        return []
    cands = [".".join(parts)]
    if len(parts) >= 2:
        cands.append(".".join(parts[:-1]) + "-" + parts[-1])
    if index:
        types = index.get("types", {})
        tname = member = None
        if parts[-1] in types:
            tname = parts[-1]
        elif len(parts) >= 2 and parts[-2] in types:
            tname, member = parts[-2], parts[-1]
        if tname:
            for entry in types[tname][:6]:
                ns = entry[3]
                sub = ns
                for pre in ("UnityEngine", "UnityEditor"):
                    if sub == pre:
                        sub = ""
                    elif sub.startswith(pre + "."):
                        sub = sub[len(pre) + 1:]
                page_type = f"{sub}.{tname}" if sub else tname
                if member:
                    cands.append(f"{page_type}.{member}")
                    cands.append(f"{page_type}-{member}")
                else:
                    cands.append(page_type)
    seen = set()
    out = []
    for c in cands:
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


_DOC_JUNK_CLASS = re.compile(
    r"\b(scrollToFeedback|suggest|sidebar|breadcrumbs|toolbar|lang-switcher|"
    r"otherversionscontent|feedbackbox|switch-link|version-number|header-wrapper)\b"
)


class _DocHTMLText(HTMLParser):
    _SKIP = {"script", "style", "nav", "footer", "header"}
    _BLOCK = {"p", "div", "section", "table", "ul", "ol", "tr", "br"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0
        self.pre = 0
        self.started = False
        self.scopes: list[list] = []

    def handle_starttag(self, tag, attrs):
        if self.scopes:
            if tag == self.scopes[-1][0]:
                self.scopes[-1][1] += 1
            return
        if tag in self._SKIP:
            self.skip += 1
            return
        if self.skip:
            return
        cls = next((v or "" for k, v in attrs if k == "class"), "")
        if _DOC_JUNK_CLASS.search(cls):
            self.scopes.append([tag, 1])
            return
        if tag == "h1":
            self.started = True
            self.parts.append("\n# ")
        elif not self.started:
            return
        elif tag in ("h2", "h3", "h4"):
            self.parts.append("\n\n" + "#" * int(tag[1]) + " ")
        elif tag == "pre":
            self.pre += 1
            self.parts.append("\n```\n")
        elif tag == "img":
            src = next((v or "" for k, v in attrs if k == "src"), "")
            name = src.rsplit("/", 1)[-1]
            if name:
                self.parts.append(f"\n[image: {name}]\n")
        elif tag == "li":
            self.parts.append("\n- ")
        elif tag in ("td", "th"):
            self.parts.append("  ")
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if self.scopes:
            if tag == self.scopes[-1][0]:
                self.scopes[-1][1] -= 1
                if self.scopes[-1][1] == 0:
                    self.scopes.pop()
            return
        if tag in self._SKIP:
            self.skip = max(0, self.skip - 1)
            return
        if self.skip or not self.started:
            return
        if tag == "pre":
            self.pre = max(0, self.pre - 1)
            self.parts.append("\n```\n")
        elif tag in self._BLOCK or tag in ("h1", "h2", "h3", "h4"):
            self.parts.append("\n")

    def handle_data(self, data):
        if self.scopes or self.skip or not self.started:
            return
        self.parts.append(data if self.pre else re.sub(r"\s+", " ", data))


_DOC_TAIL_MARKERS = (
    "Did you find this page useful",
    "Is something described here not working",
    "Copyright ©",
    "Tutorials Community Answers",
)

_XML_DOC_REF = re.compile(
    r'<(?:see|seealso)\s+cref="(?:[A-Z]:)?([^"]+)"\s*/?>'
    r'|<see\s+langword="([^"]+)"\s*/?>'
    r'|<(?:paramref|typeparamref)\s+name="([^"]+)"\s*/?>'
)
_XML_DOC_TAG = re.compile(
    r"</?(?:see|seealso|paramref|typeparamref|c|para|code|list|item|description|term|remarks"
    r"|example|inheritdoc)\b[^>]*>"
)


def _strip_xml_doc_tags(line: str) -> str:
    line = _XML_DOC_REF.sub(lambda m: m.group(1) or m.group(2) or m.group(3) or "", line)
    return _XML_DOC_TAG.sub("", line)


def doc_html_to_text(html: str) -> str:
    p = _DocHTMLText()
    p.feed(html)
    text = "".join(p.parts)
    for marker in _DOC_TAIL_MARKERS:
        idx = text.find(marker)
        if idx > 0:
            text = text[:idx]
    lines = [ln.rstrip() for ln in text.splitlines()]
    out: list[str] = []
    blank = 0
    fenced = False
    for ln in lines:
        if ln.strip().startswith("```"):
            fenced = not fenced
        elif not fenced:
            ln = _strip_xml_doc_tags(ln)
            ln = re.sub(r" {2,}", " ", ln).rstrip()
        if not ln.strip():
            blank += 1
            if blank > 1:
                continue
        else:
            blank = 0
        out.append(ln)
    return "\n".join(out).strip()


def doc_cache_path(stream: str, page: str) -> Path:
    safe = re.sub(r"[^\w.\-]", "_", page)
    return cache_root() / "docs" / (stream or "current") / f"{safe}.md"


def doc_urls(stream: str, page: str) -> list[str]:
    urls = []
    if stream:
        urls.append(f"https://docs.unity3d.com/{stream}/Documentation/ScriptReference/{page}.html")
    urls.append(f"https://docs.unity3d.com/ScriptReference/{page}.html")
    return urls


_STREAM_OK: dict[str, bool] = {}


def doc_stream_exists(stream: str) -> bool:
    if not stream:
        return True
    if stream in _STREAM_OK:
        return _STREAM_OK[stream]
    marker = cache_root() / "docs" / stream / ".stream-ok"
    if marker.exists():
        _STREAM_OK[stream] = True
        return True
    ok = False
    try:
        with _urlopen(f"https://docs.unity3d.com/{stream}/Documentation/ScriptReference/index.html",
                      timeout=30):
            ok = True
    except urllib.error.HTTPError:
        ok = False
    if ok:
        _mark_stream_ok(stream)
    _STREAM_OK[stream] = ok
    return ok


def _mark_stream_ok(stream: str) -> None:
    try:
        marker = cache_root() / "docs" / stream / ".stream-ok"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
    except OSError:
        pass


_DOC_CACHE_FORMAT = "v2"


def fetch_doc(stream: str, page: str) -> tuple[str, str] | None:
    """Cached entries are stamped with the reduction format version; an entry written by an older
    doc_html_to_text (different header) is a MISS and gets refetched — otherwise a parser fix never
    reaches pages already cached (stale reductions kept serving orphaned image captions long after
    the parser learned to emit [image: …] context lines)."""
    cpath = doc_cache_path(stream, page)
    if cpath.exists():
        try:
            cached = cpath.read_text(encoding="utf-8")
            head, _, body = cached.partition("\n")
            prefix = f"<!-- {_DOC_CACHE_FORMAT} "
            if head.startswith(prefix) and head.endswith(" -->") and body.strip():
                url = head[len(prefix):-4].strip()
                if not stream or f"/{stream}/" in url:
                    return body, url
        except OSError:
            pass
    for url in doc_urls(stream, page):
        try:
            with _urlopen(url, timeout=30) as resp:
                html = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                continue
            raise
        text = doc_html_to_text(html)
        if not text:
            continue
        versioned = bool(stream) and f"/{stream}/" in url
        cpath = doc_cache_path(stream if versioned else "", page)
        try:
            cpath.parent.mkdir(parents=True, exist_ok=True)
            _atomic_write_text(cpath, f"<!-- {_DOC_CACHE_FORMAT} {url} -->\n{text}")
        except OSError:
            pass
        if versioned:
            _mark_stream_ok(stream)
            _STREAM_OK[stream] = True
        return text, url
    return None
