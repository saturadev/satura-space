import asyncio
import filecmp
import json
import os
import re
import shutil
import time
from pathlib import Path

from . import instances
from . import proc_identity
from .sspace import ensure_sspace_for
from .control_protocol import NdjsonParser, encode_message

HOST_FILE = ".mcp_scratchpad_host.json"
SETTLED_STATUSES = ("running", "stopped", "error")

NO_APP_MESSAGE = (
    "Scratchpads need the Satura Space app: open this project in it (the app owns the scratchpad "
    "pool, launches their editors and streams them into its Scratchpads panel), then retry."
)

_GUID_RE = re.compile(rb"guid:\s*([0-9a-fA-F]{32})")
_SCRATCH_SPLIT = re.compile(r"[\\/]\.sspace[\\/]scratchpads[\\/][^\\/]+[\\/]?$")


def main_root(project_root: str = "") -> Path:
    root = instances._root(project_root)
    m = _SCRATCH_SPLIT.search(str(root))
    return Path(str(root)[: m.start()]) if m else root


def is_scratchpad_path(p) -> bool:
    return bool(_SCRATCH_SPLIT.search(str(p)))


def host_endpoint(root: Path) -> tuple[int, str]:
    try:
        data = json.loads((root / ".sspace" / HOST_FILE).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0, ""
    if not isinstance(data, dict) or not instances._alive(data.get("pid")):
        return 0, ""
    if not proc_identity.app_marker_trusted(data.get("pid"), root / ".sspace" / HOST_FILE):
        return 0, ""
    try:
        return int(data.get("controlPort") or 0), str(data.get("controlToken") or "")
    except (TypeError, ValueError):
        return 0, ""


async def request(project_root: str, action: str, *, timeout: float = 120.0, **fields) -> dict:
    root = main_root(project_root)
    port, token = host_endpoint(root)
    if port <= 0:
        return {"ok": False, "error": NO_APP_MESSAGE, "no_app": True}
    payload = {"action": action, "projectRoot": str(root), **{k: v for k, v in fields.items() if v is not None}}
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), timeout=5.0)
    except (OSError, asyncio.TimeoutError):
        return {"ok": False, "error": NO_APP_MESSAGE, "no_app": True}
    try:
        writer.write(encode_message({"type": "hello", "token": token}))
        writer.write(encode_message({"type": "command", "id": 1, "cmd": "scratchpads", "args": payload}))
        await writer.drain()
        parser = NdjsonParser()
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return {"ok": False, "error": "timeout waiting for the Satura Space app"}
            try:
                chunk = await asyncio.wait_for(reader.read(65536), timeout=remaining)
            except asyncio.TimeoutError:
                return {"ok": False, "error": "timeout waiting for the Satura Space app"}
            if not chunk:
                return {"ok": False, "error": "the Satura Space app closed the connection"}
            for msg in parser.push(chunk):
                if msg.get("type") == "result":
                    return {k: v for k, v in msg.items() if k not in ("type", "id", "status")}
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except OSError:
            pass


async def wait_for_status(project_root: str, scratchpad: str, want: tuple, timeout: float,
                          poll: float = 2.0) -> dict:
    deadline = time.monotonic() + max(0.0, timeout)
    last = None
    while True:
        r = await request(project_root, "list")
        if not r.get("ok"):
            return r
        last = next((s for s in r.get("scratchpads") or [] if s.get("id") == scratchpad), None)
        if last is None:
            return {"ok": False, "error": f"Scratchpad {scratchpad} disappeared."}
        if last.get("status") in want or time.monotonic() >= deadline:
            return {"ok": True, "scratchpad": last}
        await asyncio.sleep(poll)


def _meta_guid(meta: Path) -> str | None:
    try:
        m = _GUID_RE.search(meta.read_bytes())
    except OSError:
        return None
    return m.group(1).decode().lower() if m else None


def guid_index(root: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    assets = root / "Assets"
    for dirpath, _dirs, files in os.walk(assets):
        for f in files:
            if not f.endswith(".meta"):
                continue
            meta = Path(dirpath) / f
            guid = _meta_guid(meta)
            if guid:
                out[guid] = meta.relative_to(root).as_posix()[: -len(".meta")]
    return out


def _referenced_guids(path: Path) -> set[str]:
    try:
        data = path.read_bytes()
    except OSError:
        return set()
    if b"\0" in data[:8000]:
        return set()
    return {g.decode().lower() for g in _GUID_RE.findall(data)}


def _clean_rel(p: str) -> str | None:
    rel = str(p).replace("\\", "/").strip().strip("/")
    if rel.endswith(".meta"):
        rel = rel[: -len(".meta")]
    parts = rel.split("/")
    if not rel or parts[0] != "Assets" or ".." in parts:
        return None
    return rel


def _expand(root: Path, rel: str) -> list[str]:
    p = root / rel
    if p.is_file():
        return [rel]
    out = []
    for dirpath, dirs, files in os.walk(p):
        dirs.sort()
        base = Path(dirpath)
        if base != p:
            out.append(base.relative_to(root).as_posix())
        for f in sorted(files):
            if not f.endswith(".meta"):
                out.append((base / f).relative_to(root).as_posix())
    return out


def plan_transfer(src: Path, paths, with_deps: bool = True) -> dict:
    missing, invalid = [], []
    todo: list[str] = []
    for raw in paths or []:
        rel = _clean_rel(raw)
        if rel is None:
            invalid.append(str(raw))
            continue
        if not (src / rel).exists():
            missing.append(rel)
            continue
        todo.append(rel)
    selected: list[str] = []
    seen: set[str] = set()
    index = guid_index(src) if with_deps else {}
    queue = [x for rel in todo for x in _expand(src, rel)]
    deps: list[str] = []
    while queue:
        rel = queue.pop(0)
        if rel in seen:
            continue
        seen.add(rel)
        selected.append(rel)
        if not with_deps or (src / rel).is_dir():
            continue
        for guid in sorted(_referenced_guids(src / rel)):
            dep = index.get(guid)
            if dep and dep not in seen and (src / dep).exists():
                deps.append(dep)
                queue.extend(_expand(src, dep))
    return {"files": selected, "dependencies": sorted(set(deps) - set(todo)),
            "missing": missing, "invalid": invalid}


def _parents(rel: str) -> list[str]:
    parts = rel.split("/")
    return ["/".join(parts[:i]) for i in range(2, len(parts))]


def transfer(src: Path, dst: Path, paths, overwrite: bool = False, with_deps: bool = True) -> dict:
    plan = plan_transfer(src, paths, with_deps)
    ensure_sspace_for(dst)
    dst_index = guid_index(dst)
    copied, unchanged, conflicts = [], [], []
    folders: set[str] = set()
    for rel in plan["files"]:
        s, d = src / rel, dst / rel
        s_meta, d_meta = Path(f"{s}.meta"), Path(f"{d}.meta")
        if s.is_dir():
            folders.add(rel)
            continue
        guid = _meta_guid(s_meta) if s_meta.exists() else None
        other = dst_index.get(guid) if guid else None
        if other and other != rel:
            conflicts.append(f"{rel}: its GUID is already used by {other} in the destination")
            continue
        same = d.exists() and filecmp.cmp(s, d, shallow=False) and (
            not s_meta.exists() or (d_meta.exists() and filecmp.cmp(s_meta, d_meta, shallow=False)))
        if same:
            unchanged.append(rel)
            continue
        if d.exists() and not overwrite:
            conflicts.append(f"{rel}: already exists with different content (pass overwrite=True)")
            continue
        for parent in _parents(rel):
            folders.add(parent)
        d.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(s, d)
        if s_meta.exists():
            shutil.copy2(s_meta, d_meta)
        copied.append(rel)
    for folder in sorted(folders):
        (dst / folder).mkdir(parents=True, exist_ok=True)
        s_meta, d_meta = src / f"{folder}.meta", dst / f"{folder}.meta"
        if s_meta.exists() and not d_meta.exists():
            shutil.copy2(s_meta, d_meta)
    return {**plan, "copied": copied, "unchanged": unchanged, "conflicts": conflicts}
