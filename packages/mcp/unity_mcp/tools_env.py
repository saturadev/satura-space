import asyncio
import difflib
import hashlib
import json
import os
import random
import re
import stat
import subprocess
import sys
import tempfile
import time

from contextlib import contextmanager
from typing import Annotated, Literal

from pydantic import Field

from .file_lock import _try_lock, _unlock
from .helpers import resolve_root, tool_guard
from .sspace import SSPACE_DIR, ensure_sspace_dir

NEVER_COMMIT_FILE = "never-commit.json"
NEVER_COMMIT_LOCK = ".never-commit.lock"
LOCK_WAIT_S = 10
BLOB_GRACE_S = 60
ENV_BLOB_DIR = "env"
MAX_SHOW_BYTES = 5 * 1024 * 1024
BINARY_SNIFF_BYTES = 8000
LFS_POINTER_MAX_BYTES = 1024
LFS_POINTER_PREFIX = b"version https://git-lfs.github.com/spec/v1"
ENV_MERGE_LABELS = ("working file", "env snapshot", "without env edits")
ENV_MERGE_ATTRIBUTES = ("merge", "text", "binary")
MAX_CLI_LENGTH = 30000
STATUS_LIMIT = 10000
COMMANDS = ("list", "check", "add", "remove", "keep", "stage", "diff")

_REGULAR_FILE_MODE = re.compile(r"100(644|755)")
_SHA = re.compile(r"[0-9a-f]{40}")
_LS_FILES_RECORD = re.compile(r"([0-9]+) ([0-9a-f]+) ([0-9])\t(.*)", re.DOTALL)
_ARRAY_INDEX = re.compile(r"0|[1-9][0-9]*")
_JS_WHITESPACE = "\t\n\v\f\r                  　﻿"
_UNMERGED = {"DD", "AU", "UD", "UA", "DU", "AA", "UU"}
_GIT_TIMEOUT = 120
_GIT_ENV = {"LANGUAGE": "en", "LC_ALL": "en_US.UTF-8", "LANG": "en_US.UTF-8", "GIT_PAGER": "cat", "GIT_TERMINAL_PROMPT": "0",
            "GIT_LITERAL_PATHSPECS": "1"}


class EnvError(Exception):
    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.message = message
        self.code = code


def _run_git(cwd: str, args, *, input: bytes | None = None, no_optional_locks: bool = True, env=None):
    cmd = ["git", *(["--no-optional-locks"] if no_optional_locks else []), *args]
    full_env = {**os.environ, **(env or {}), **_GIT_ENV}
    try:
        return subprocess.run(cmd, cwd=cwd, input=input, stdin=None if input is not None else subprocess.DEVNULL,
                              capture_output=True, timeout=_GIT_TIMEOUT, env=full_env)
    except FileNotFoundError:
        raise EnvError("git is not installed or not on PATH")
    except subprocess.TimeoutExpired:
        raise EnvError(f"git {args[0]} timed out after {_GIT_TIMEOUT}s")


def _git(cwd: str, *args, input: bytes | None = None, no_optional_locks: bool = True, env=None) -> bytes:
    proc = _run_git(cwd, args, input=input, no_optional_locks=no_optional_locks, env=env)
    if proc.returncode != 0:
        msg = proc.stderr.decode("utf-8", "replace").strip() or f"exit code {proc.returncode}"
        raise EnvError(f"git {args[0]} failed in {cwd}: {msg}")
    return proc.stdout


def _decode(out: bytes) -> str:
    return out.decode("utf-8", "replace")


def _rev_parse_line(out: bytes) -> str:
    return os.path.normpath(re.sub(r"[\r\n]+$", "", _decode(out).lstrip()))


def _js_trim(s: str) -> str:
    return s.strip(_JS_WHITESPACE)


def _js_sort_key(s: str) -> bytes:
    return s.encode("utf-16-be", "surrogatepass")


def normalize_entry(raw: str) -> str:
    p = _js_trim(raw.replace("\\", "/"))
    if p.endswith("/"):
        return ""
    p = re.sub(r"^(\./)+", "", p)
    p = re.sub(r"^/+", "", p)
    p = re.sub(r"/+", "/", p)
    if not p or p == "." or ".." in p.split("/"):
        return ""
    return p


def normalize_entries(raw) -> list[str]:
    return sorted({n for n in (normalize_entry(r) for r in raw if isinstance(r, str)) if n}, key=_js_sort_key)


def git_blob_sha(content: bytes) -> str:
    h = hashlib.sha1()
    h.update(f"blob {len(content)}\0".encode("ascii"))
    h.update(content)
    return h.hexdigest()


def is_text(buf: bytes) -> bool:
    return b"\0" not in buf[:BINARY_SNIFF_BYTES]


def is_lfs_pointer(buf: bytes) -> bool:
    return len(buf) < LFS_POINTER_MAX_BYTES and buf[:len(LFS_POINTER_PREFIX)] == LFS_POINTER_PREFIX


def is_env_mergeable(attributes: dict | None) -> bool:
    if attributes is None:
        return False
    binary = attributes.get("binary", "unspecified")
    text = attributes.get("text", "unspecified")
    merge = attributes.get("merge", "unspecified")
    return binary in ("unspecified", "unset") and text != "unset" and merge in ("unspecified", "set", "text")


def _reject_constant(name):
    raise ValueError(name)


def parse_never_commit_data(raw: str) -> tuple[list[str], dict[str, dict[str, str]]]:
    try:
        return parse_never_commit_strict(raw)
    except ValueError:
        return [], {}


def parse_never_commit_strict(raw: str) -> tuple[list[str], dict[str, dict[str, str]]]:
    snapshots: dict[str, dict[str, str]] = {}
    text = raw[1:] if raw.startswith("\ufeff") else raw
    if not text.strip():
        return [], snapshots
    data = json.loads(text, parse_constant=_reject_constant)
    if not isinstance(data, dict):
        raise ValueError("not a JSON object")
    entries_raw = data.get("entries")
    if not isinstance(entries_raw, list):
        raise ValueError("no entries list")
    entries = normalize_entries([e for e in entries_raw if isinstance(e, str)])
    raw_snapshots = data.get("snapshots")
    if isinstance(raw_snapshots, dict):
        known = set(entries)
        for path, value in _js_object_items(raw_snapshots):
            if path in known and isinstance(value, dict):
                env, base = value.get("env"), value.get("base")
                if isinstance(env, str) and _SHA.fullmatch(env) and isinstance(base, str) and _SHA.fullmatch(base):
                    snapshots[path] = {"env": env, "base": base}
    return entries, snapshots


def _is_array_index(key: str) -> bool:
    return bool(_ARRAY_INDEX.fullmatch(key)) and int(key) < 2 ** 32 - 1


def _js_object_items(obj: dict) -> list:
    indexed = sorted((k for k in obj if _is_array_index(k)), key=int)
    return [(k, obj[k]) for k in indexed] + [(k, v) for k, v in obj.items() if not _is_array_index(k)]


def never_commit_path(sspace_dir: str) -> str:
    return os.path.join(sspace_dir, NEVER_COMMIT_FILE)


def env_blob_path(sspace_dir: str, sha: str) -> str:
    return os.path.join(sspace_dir, ENV_BLOB_DIR, sha)


def read_never_commit_data(sspace_dir: str) -> tuple[list[str], dict[str, dict[str, str]]]:
    try:
        with open(never_commit_path(sspace_dir), "rb") as fh:
            raw = fh.read().decode("utf-8", "replace")
    except OSError:
        return [], {}
    return parse_never_commit_data(raw)


def read_never_commit_for_update(sspace_dir: str) -> tuple[str, list[str], dict, str | None]:
    try:
        with open(never_commit_path(sspace_dir), "rb") as fh:
            raw = fh.read().decode("utf-8", "replace")
    except FileNotFoundError:
        return "missing", [], {}, None
    except OSError as e:
        return "invalid", [], {}, str(e)
    try:
        entries, snapshots = parse_never_commit_strict(raw)
    except ValueError as e:
        return "invalid", [], {}, str(e)
    return "ok", entries, snapshots, None


@contextmanager
def never_commit_lock(sspace_dir: str, timeout: float | None = None):
    ensure_sspace_dir(sspace_dir)
    fd = os.open(os.path.join(sspace_dir, NEVER_COMMIT_LOCK), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        deadline = time.monotonic() + max(0.0, LOCK_WAIT_S if timeout is None else timeout)
        while not _try_lock(fd):
            if time.monotonic() >= deadline:
                raise EnvError("The Env Changes list is busy: another window or agent is changing it. Try again.", "EnvBusy")
            time.sleep(0.1)
        try:
            yield
        finally:
            _unlock(fd)
    finally:
        os.close(fd)


def update_never_commit_data(sspace_dir: str, mutate) -> tuple[list[str], dict]:
    with never_commit_lock(sspace_dir):
        state, entries, snapshots, error = read_never_commit_for_update(sspace_dir)
        if state == "invalid":
            raise EnvError(f"Can't read the Env Changes list {never_commit_path(sspace_dir)} ({error}), so nothing was changed. "
                           "Fix or delete that file and try again.", "EnvUnreadable")
        new_entries, new_snapshots = mutate(entries, snapshots)
        return write_never_commit_data(sspace_dir, new_entries, new_snapshots)


def _base36(n: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while True:
        n, r = divmod(n, 36)
        out = digits[r] + out
        if n == 0:
            return out


def write_sspace_file(sspace_dir: str, name: str, content: bytes) -> None:
    ensure_sspace_dir(sspace_dir)
    file = os.path.join(sspace_dir, name)
    os.makedirs(os.path.dirname(file), exist_ok=True)
    tmp = f"{file}.{os.getpid()}.{int(time.time() * 1000)}.{_base36(random.getrandbits(52))}.tmp"
    try:
        with open(tmp, "wb") as fh:
            fh.write(content)
        os.replace(tmp, file)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def write_env_blob(sspace_dir: str, content: bytes) -> str:
    sha = git_blob_sha(content)
    path = env_blob_path(sspace_dir, sha)
    if os.path.exists(path):
        try:
            os.utime(path, None)
        except OSError:
            pass
    else:
        write_sspace_file(sspace_dir, os.path.join(ENV_BLOB_DIR, sha), content)
    return sha


def _drop_unreferenced_blobs(sspace_dir: str, snapshots: dict) -> None:
    keep = set()
    for s in snapshots.values():
        keep.add(s["env"])
        keep.add(s["base"])
    try:
        names = os.listdir(os.path.join(sspace_dir, ENV_BLOB_DIR))
    except OSError:
        return
    cutoff = time.time() - BLOB_GRACE_S
    for n in names:
        if _SHA.fullmatch(n) and n not in keep:
            path = env_blob_path(sspace_dir, n)
            try:
                if os.stat(path).st_mtime > cutoff:
                    continue
                os.remove(path)
            except OSError:
                pass


def serialize_never_commit(entries: list[str], snapshots: dict) -> str:
    body: dict = {"version": 1, "entries": entries}
    if snapshots:
        ordered = sorted(snapshots.items(), key=lambda kv: _js_sort_key(kv[0]))
        body["snapshots"] = {k: {"env": v["env"], "base": v["base"]} for k, v in _js_object_items(dict(ordered))}
    return json.dumps(body, indent=2, ensure_ascii=False) + "\n"


def write_never_commit_data(sspace_dir: str, entries, snapshots: dict) -> tuple[list[str], dict]:
    entries = normalize_entries(list(entries))
    known = set(entries)
    kept = {k: v for k, v in snapshots.items() if k in known}
    write_sspace_file(sspace_dir, NEVER_COMMIT_FILE, serialize_never_commit(entries, kept).encode("utf-8"))
    _drop_unreferenced_blobs(sspace_dir, kept)
    return entries, kept


def _is_descendant(parent: str, descendant: str) -> bool:
    if parent == descendant:
        return True

    def norm(p: str) -> str:
        if os.name == "nt" or sys.platform == "darwin":
            p = p.lower()
        if p.endswith(("/", "\\")):
            p = p[:-1]
        return os.path.normpath(p)

    parent, descendant = norm(parent), norm(descendant)
    if not parent.endswith(os.sep):
        parent += os.sep
    return descendant.startswith(parent)


def _chunks(values: list[str], max_length: int):
    current: list[str] = []
    length = 0
    for value in values:
        new_length = length + len(value)
        if new_length > max_length and current:
            yield current
            current = []
            new_length = len(value)
        current.append(value)
        length = new_length
    if current:
        yield current


def parse_status(raw: str) -> list[dict]:
    result: list[dict] = []
    i = 0
    while True:
        if i + 4 >= len(raw):
            break
        x, y = raw[i], raw[i + 1]
        i += 3
        rename = None
        if x == "R" or y == "R" or x == "C":
            j = raw.find("\0", i)
            if j == -1:
                break
            rename = raw[i:j]
            i = j + 1
        j = raw.find("\0", i)
        if j == -1:
            break
        path = raw[i:j]
        if not path.endswith("/"):
            result.append({"x": x, "y": y, "path": path, "rename": rename})
        i = j + 1
    return result


def resource_groups(status: list[dict]) -> tuple[list[dict], list[dict]]:
    index: list[dict] = []
    working: list[dict] = []
    for raw in status:
        xy = raw["x"] + raw["y"]
        if xy in ("??", "!!") or xy in _UNMERGED:
            continue
        if raw["x"] in ("M", "A", "D"):
            index.append({"kind": raw["x"], "path": raw["path"]})
        elif raw["x"] in ("R", "C"):
            index.append({"kind": raw["x"], "path": raw["rename"] or raw["path"]})
        if raw["y"] == "M":
            working.append({"kind": "M", "path": raw["rename"] or raw["path"]})
        elif raw["y"] in ("D", "R"):
            working.append({"kind": raw["y"], "path": raw["rename"] or raw["path"]})
        elif raw["y"] in ("A", "T"):
            working.append({"kind": raw["y"], "path": raw["path"]})
    return index, working


class EnvRepo:
    def __init__(self, cwd: str):
        proc = _run_git(cwd, ["rev-parse", "--show-toplevel"])
        if proc.returncode != 0 and "not a git repository" in proc.stderr.decode("utf-8", "replace"):
            raise EnvError(f"{cwd} is not a git repository, so there are no Env Changes to list or commit. "
                           "env.* works once the project is in git (git init).", "NotGitRepo")
        self.root = _rev_parse_line(proc.stdout if proc.returncode == 0 else _git(cwd, "rev-parse", "--show-toplevel"))
        common = _rev_parse_line(_git(self.root, "rev-parse", "--path-format=absolute", "--git-common-dir"))
        project = os.path.dirname(common) if os.path.basename(common) == ".git" else self.root
        self.sspace = os.path.join(project, SSPACE_DIR)

    def read(self) -> tuple[list[str], dict]:
        return read_never_commit_data(self.sspace)

    def read_working(self, rel: str, limit: int):
        absolute = os.path.normpath(os.path.join(self.root, rel))
        if absolute == os.path.normpath(self.root) or not _is_descendant(self.root, absolute):
            return ("missing", None)
        try:
            st = os.stat(absolute)
        except OSError:
            return ("missing", None)
        if not stat.S_ISREG(st.st_mode):
            return ("missing", None)
        if st.st_size > limit:
            return ("tooLarge", st.st_size)
        try:
            with open(absolute, "rb") as fh:
                return ("bytes", fh.read())
        except OSError:
            return ("missing", None)

    def index_content(self, rel: str) -> bytes:
        proc = _run_git(self.root, ["cat-file", "--filters", f":0:{rel}"])
        if proc.returncode != 0:
            raise EnvError("Could not read the file from the index.")
        return proc.stdout

    def index_entries(self, paths: list[str]) -> dict[str, dict]:
        entries: dict[str, dict] = {}
        for chunk in _chunks(list(paths), MAX_CLI_LENGTH):
            out = _decode(_git(self.root, "ls-files", "--stage", "-z", "--", *chunk))
            for record in out.split("\0"):
                m = _LS_FILES_RECORD.fullmatch(record)
                if not m:
                    continue
                mode, obj, stage, file = m.groups()
                previous = entries.get(file)
                entries[file] = {"mode": mode, "object": obj, "unmerged": stage != "0" or bool(previous and previous["unmerged"])}
        return entries

    def exists(self, rel: str) -> bool:
        if os.path.lexists(os.path.join(self.root, rel)):
            return True
        return bool(_git(self.root, "ls-files", "-z", "--", rel.rstrip('/')).strip(b"\0"))

    def staged_paths(self, paths: list[str]) -> set[str]:
        staged: set[str] = set()
        for chunk in _chunks(list(paths), MAX_CLI_LENGTH):
            out = _decode(_git(self.root, "diff", "--cached", "--name-only", "--no-renames", "-z", "--", *chunk))
            staged.update(f for f in out.split("\0") if f)
        return staged

    def check_attr(self, paths: list[str]) -> dict[str, dict[str, str]]:
        result: dict[str, dict[str, str]] = {}
        if not paths:
            return result
        data = "".join(f"{p}\0" for p in paths).encode("utf-8")
        fields = _decode(_git(self.root, "check-attr", "-z", "--stdin", *ENV_MERGE_ATTRIBUTES, input=data)).split("\0")
        for i in range(0, len(fields) - 2, 3):
            result.setdefault(fields[i], {})[fields[i + 1]] = fields[i + 2]
        return result

    def mergeable_paths(self, paths) -> set[str]:
        unique = list(dict.fromkeys(paths))
        if not unique:
            return set()
        try:
            attributes = self.check_attr(unique)
        except EnvError:
            attributes = {}
        return {p for p in unique if is_env_mergeable(attributes.get(p))}

    def mergeable_snapshots(self, snapshots: dict, paths) -> dict:
        candidates = [p for p in dict.fromkeys(paths) if p in snapshots]
        mergeable = self.mergeable_paths(candidates)
        return {p: snapshots[p] for p in candidates if p in mergeable}

    def merge_file(self, current: str, base: str, other: str) -> tuple[bytes, int]:
        l0, l1, l2 = ENV_MERGE_LABELS
        proc = _run_git(self.root, ["merge-file", "-p", "-L", l0, "-L", l1, "-L", l2, "--", current, base, other])
        if proc.returncode < 0 or proc.returncode > 127:
            raise EnvError("Could not merge the file.")
        return proc.stdout, proc.returncode

    def strip_env(self, snapshot: dict, current: str) -> tuple[bytes, int] | None:
        env = env_blob_path(self.sspace, snapshot["env"])
        base = env_blob_path(self.sspace, snapshot["base"])
        if not (os.path.exists(env) and os.path.exists(base)):
            return None
        return self.merge_file(current, env, base)

    def env_residual_of(self, rel: str, snapshot: dict) -> dict | None:
        kind, working = self.read_working(rel, MAX_SHOW_BYTES)
        if kind != "bytes" or not is_text(working) or git_blob_sha(working) == snapshot["env"]:
            return None
        stripped = self.strip_env(snapshot, os.path.normpath(os.path.join(self.root, rel)))
        if stripped is None or stripped[0] == self.index_content(rel):
            return None
        return {"path": rel, "conflict": stripped[1] > 0}

    def staged_without_env(self, rel: str, snapshot: dict | None) -> bool:
        if not snapshot:
            return False
        index = self.index_content(rel)
        sha = git_blob_sha(index)
        if sha == snapshot["base"]:
            return True
        if sha == snapshot["env"] or len(index) > MAX_SHOW_BYTES or not is_text(index):
            return False
        fd, tmp = tempfile.mkstemp(prefix=f"sspace-env-{os.getpid()}-")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(index)
            stripped = self.strip_env(snapshot, tmp)
            return stripped is not None and stripped[1] == 0 and stripped[0] == index
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass

    def status(self) -> list[dict]:
        out = _git(self.root, "status", "-z", "-uall", env={"GIT_OPTIONAL_LOCKS": "0"})
        return parse_status(_decode(out))[:STATUS_LIMIT]

    def classify(self, entries: list[str], snapshots: dict) -> tuple[list[dict], list[str], dict]:
        env_residual: list[dict] = []
        env_staged_unsafe: list[str] = []
        known = set(entries)
        if not known:
            return env_residual, env_staged_unsafe, {}
        index_group, working_group = resource_groups(self.status())
        usable = self.mergeable_snapshots(snapshots, [c["path"] for c in working_group if c["kind"] == "M"]
                                          + [c["path"] for c in index_group if c["path"] in known])
        for change in working_group:
            snapshot = usable.get(change["path"])
            if change["kind"] != "M" or not snapshot:
                continue
            try:
                residual = self.env_residual_of(change["path"], snapshot)
            except Exception:
                residual = None
            if residual:
                env_residual.append(residual)
        for change in index_group:
            if change["path"] not in known:
                continue
            try:
                safe = self.staged_without_env(change["path"], usable.get(change["path"]))
            except Exception:
                safe = False
            if not safe:
                env_staged_unsafe.append(change["path"])
        return env_residual, env_staged_unsafe, usable

    def snapshot_env(self, paths: list[str]) -> dict[str, dict | None]:
        snapshots: dict[str, dict | None] = {}
        if not paths:
            return snapshots
        index = self.index_entries(paths)
        mergeable = self.mergeable_paths(paths)
        for rel in paths:
            snapshots[rel] = None
            entry = index.get(rel)
            if not entry or entry["unmerged"] or not _REGULAR_FILE_MODE.fullmatch(entry["mode"]) or rel not in mergeable:
                continue
            kind, working = self.read_working(rel, MAX_SHOW_BYTES)
            if kind != "bytes" or not is_text(working):
                continue
            try:
                base = self.index_content(rel)
            except EnvError:
                continue
            if len(base) > MAX_SHOW_BYTES or not is_text(base) or is_lfs_pointer(base) or base == working:
                continue
            snapshots[rel] = {"env": write_env_blob(self.sspace, working), "base": write_env_blob(self.sspace, base)}
        return snapshots

    def assert_not_staged(self, paths: list[str], action: str, allowed=None) -> None:
        if not paths:
            return
        staged: list[str] = []
        for rel in sorted(self.staged_paths(paths), key=_js_sort_key):
            ok = False
            if allowed is not None:
                try:
                    ok = allowed(rel)
                except Exception:
                    ok = False
            if not ok:
                staged.append(rel)
        if not staged:
            return
        if len(staged) == 1:
            message = f"{staged[0]} has staged changes. Unstage it first, then {action}."
        else:
            message = f"{len(staged)} files have staged changes ({', '.join(staged)}). Unstage them first, then {action}."
        raise EnvError(message, "EnvStaged")

    def update_never_commit(self, add=(), remove=()) -> list[str]:
        drop = set(normalize_entries(list(remove)))
        wanted = [e for e in normalize_entries(list(add)) if e not in drop]
        listed = set(self.read()[0])
        self.assert_not_staged([e for e in wanted if e not in listed], "add it to Env Changes")

        def mutate(current, stored):
            previous = set(current)
            snapshots = dict(stored)
            added = [e for e in wanted if e not in previous]
            self.assert_not_staged(added, "add it to Env Changes")
            for rel, snapshot in self.snapshot_env(added).items():
                if snapshot:
                    snapshots[rel] = snapshot
            return [e for e in current if e not in drop] + added, snapshots

        return update_never_commit_data(self.sspace, mutate)[0]

    def keep_env(self, paths: list[str]) -> None:
        def mutate(entries, stored):
            known = set(entries)
            snapshots = dict(stored)
            targets = [p for p in dict.fromkeys(paths) if p in known]
            usable = self.mergeable_snapshots(stored, targets)
            self.assert_not_staged(targets, "use Keep as Env", lambda rel: self.staged_without_env(rel, usable.get(rel)))
            for rel, snapshot in self.snapshot_env(targets).items():
                if snapshot:
                    snapshots[rel] = snapshot
                else:
                    snapshots.pop(rel, None)
            return entries, snapshots

        update_never_commit_data(self.sspace, mutate)

    def hash_object(self, rel: str, content: bytes) -> str:
        return _decode(_git(self.root, "hash-object", "-w", "--stdin", f"--path={rel}", input=content,
                            no_optional_locks=False)).strip()

    def update_index_cacheinfo(self, mode: str, obj: str, rel: str) -> None:
        _git(self.root, "update-index", "--cacheinfo", f"{mode},{obj},{rel}", no_optional_locks=False)

    def add(self, paths: list[str]) -> None:
        for chunk in _chunks(paths, MAX_CLI_LENGTH):
            _git(self.root, "add", "-A", "--", *chunk, no_optional_locks=False)

    def stage(self, paths: list[str]) -> list[str]:
        _, stored = self.read()
        usable = self.mergeable_snapshots(stored, paths)
        env_paths = [p for p in dict.fromkeys(paths) if p in usable]
        plain = [p for p in paths if p not in usable]
        blocked: list[str] = []
        stripped_paths: list[str] = []
        if env_paths:
            index = self.index_entries(env_paths)
            for rel in env_paths:
                entry = index.get(rel)
                kind, working = self.read_working(rel, MAX_SHOW_BYTES)
                stripped = None
                if entry and not entry["unmerged"] and kind == "bytes" and is_text(working):
                    stripped = self.strip_env(usable[rel], os.path.normpath(os.path.join(self.root, rel)))
                if not entry or not stripped:
                    plain.append(rel)
                elif stripped[1] > 0:
                    blocked.append(rel)
                else:
                    obj = self.hash_object(rel, stripped[0])
                    self.update_index_cacheinfo(entry["mode"], obj, rel)
                    stripped_paths.append(rel)
        if plain:
            self.add(plain)
        if blocked:
            if len(blocked) == 1:
                message = (f"Didn't stage {blocked[0]}: the new edits touch the same lines as your env edits, so git can't "
                           "split them apart. Move them apart in the file, or use Keep as Env.")
            else:
                message = (f"Didn't stage {len(blocked)} env files ({', '.join(blocked)}): the new edits touch the same lines "
                           "as your env edits, so git can't split them apart. Move them apart in the files, or use Keep as Env.")
            raise EnvError(message)
        return stripped_paths

    def env_stripped(self, rel: str) -> tuple[bytes | None, int]:
        kind, working = self.read_working(rel, MAX_SHOW_BYTES)
        if kind != "bytes":
            return None, 0
        _, stored = self.read()
        snapshot = self.mergeable_snapshots(stored, [rel]).get(rel)
        if not snapshot or len(working) > MAX_SHOW_BYTES or not is_text(working):
            return working, 0
        stripped = self.strip_env(snapshot, os.path.normpath(os.path.join(self.root, rel)))
        return stripped if stripped else (working, 0)


def _repo_relative(raw: str, repo: EnvRepo) -> str:
    p = raw
    if os.path.isabs(p):
        try:
            rel = os.path.relpath(os.path.realpath(p), os.path.realpath(repo.root))
        except ValueError:
            rel = ".."
        if rel == ".." or rel.startswith(".." + os.sep):
            return ""
        p = rel + ("/" if raw.endswith(("/", "\\")) else "")
    return normalize_entry(p)


def _resolve_paths(repo: EnvRepo, raw_paths) -> tuple[list[str], list[str]]:
    good: list[str] = []
    bad: list[str] = []
    for raw in raw_paths:
        rel = _repo_relative(raw, repo) if isinstance(raw, str) else ""
        if rel:
            if rel not in good:
                good.append(rel)
        else:
            bad.append(str(raw))
    return good, bad


def _states(repo: EnvRepo, entries: list[str], snapshots: dict) -> tuple[dict[str, list[str]], list[dict], list[str], dict]:
    residual, unsafe, usable = repo.classify(entries, snapshots)
    if entries:
        usable = {**usable, **repo.mergeable_snapshots(snapshots, [e for e in entries if e not in usable])}
    by_path = {r["path"]: r for r in residual}
    unsafe_set = set(unsafe)
    states: dict[str, list[str]] = {}
    ignored = {e for e in snapshots if e not in usable}
    for e in entries:
        s: list[str] = []
        if e in unsafe_set:
            s.append("staged-unsafe")
        if e in by_path:
            s.append("conflict" if by_path[e]["conflict"] else "new changes")
        elif e in usable:
            s.append("env-only")
        else:
            s.append("no snapshot (.gitattributes)" if e in ignored else "no snapshot")
        states[e] = s
    return states, residual, unsafe, usable


def env_exec(root: str, command: str, paths=None) -> dict:
    command = (command or "").strip().lower()
    paths = list(paths or [])
    if command not in COMMANDS:
        return {"ok": False, "command": command, "error": f"Unknown command {command!r}. Use one of: {', '.join('env.' + c for c in COMMANDS)}."}
    try:
        repo = EnvRepo(root)
        resolved, invalid = _resolve_paths(repo, paths)
        result: dict = {"ok": True, "command": command, "root": repo.root, "file": never_commit_path(repo.sspace),
                        "invalid": invalid}
        if command != "list" and not resolved:
            outside = (f"{', '.join(str(p) for p in paths)} {'is' if len(paths) == 1 else 'are'} outside the repository {repo.root}."
                       if paths else f"env.{command}() needs at least one file path in the repository.")
            return {**result, "ok": False, "error": outside}
        entries, snapshots = repo.read()
        known = set(entries)
        if command in ("list", "check"):
            states, residual, unsafe, usable = _states(repo, entries, snapshots)
            result.update({"entries": entries, "states": states, "envResidual": residual, "envStagedUnsafe": unsafe,
                           "snapshots": sorted(usable, key=_js_sort_key)})
            if command == "check":
                result["checked"] = [{"path": p, "env": p in known, "states": states.get(p, [])} for p in resolved]
            return result
        if command == "add":
            missing = [p for p in resolved if p not in known and not repo.exists(p)]
            if missing:
                return {**result, "ok": False, "code": "EnvMissing", "error": (
                    f"Didn't add anything: {', '.join(missing)} {'does' if len(missing) == 1 else 'do'} not exist in "
                    f"{repo.root}, on disk or in git. Check the path; it is relative to the repository root.")}
            new = [p for p in resolved if p not in known]
            if not new:
                return {**result, "added": [], "snapshotted": [], "entries": entries}
            nxt = repo.update_never_commit(add=new)
            _, after = repo.read()
            return {**result, "added": new, "snapshotted": [p for p in new if p in after], "entries": nxt}
        if command == "remove":
            gone = [p for p in resolved if p in known]
            result["notEnv"] = [p for p in resolved if p not in known]
            if not gone:
                return {**result, "removed": [], "entries": entries}
            nxt = repo.update_never_commit(remove=gone)
            return {**result, "removed": gone, "entries": nxt}
        if command == "keep":
            targets = [p for p in resolved if p in known]
            result["notEnv"] = [p for p in resolved if p not in known]
            if targets:
                repo.keep_env(targets)
            _, after = repo.read()
            return {**result, "kept": targets, "snapshotted": [p for p in targets if p in after]}
        if command == "stage":
            usable = repo.mergeable_snapshots(snapshots, resolved)
            whole = [p for p in resolved if p in known and p not in usable]
            if whole:
                return {**result, "ok": False, "code": "EnvWholeFile", "error": (
                    f"Didn't stage anything: {', '.join(whole)} {'is an env file' if len(whole) == 1 else 'are env files'} "
                    "with no snapshot, so the whole file stays out of commits.")}
            folders = [p for p in resolved if os.path.isdir(os.path.join(repo.root, p))]
            if folders:
                return {**result, "ok": False, "error": (
                    f"Didn't stage anything: {', '.join(folders)} {'is a folder' if len(folders) == 1 else 'are folders'}. "
                    "Pass file paths so env files inside aren't staged by accident.")}
            plain = [p for p in resolved if p not in known]
            if plain:
                return {**result, "ok": False, "code": "EnvNotEnv", "error": (
                    f"Didn't stage anything: {', '.join(plain)} {'is not an env file' if len(plain) == 1 else 'are not env files'}. "
                    "env.stage only stages env files; stage normal files with git add <path>.")}
            before = {p: repo.read_working(p, MAX_SHOW_BYTES) for p in resolved if p in usable}
            try:
                stripped = repo.stage(resolved)
            except EnvError as e:
                return {**result, "ok": False, "error": e.message, "code": e.code}
            untouched = all(repo.read_working(p, MAX_SHOW_BYTES) == v for p, v in before.items())
            return {**result, "staged": resolved, "strippedEnv": stripped, "workingUntouched": untouched}
        if command == "diff":
            diffs = []
            for p in resolved:
                if p not in known:
                    diffs.append({"path": p, "env": False})
                    continue
                snapshot = repo.mergeable_snapshots(snapshots, [p]).get(p)
                if not snapshot:
                    diffs.append({"path": p, "env": True, "snapshot": False})
                    continue
                try:
                    index = repo.index_content(p)
                except EnvError:
                    index = b""
                stripped, conflicts = repo.env_stripped(p)
                text_a = index.decode("utf-8", "replace")
                text_b = (stripped or b"").decode("utf-8", "replace")
                lines = list(difflib.unified_diff(text_a.splitlines(keepends=True), text_b.splitlines(keepends=True),
                                                  fromfile=f"a/{p}", tofile=f"b/{p}"))
                diffs.append({"path": p, "env": True, "snapshot": True, "conflict": conflicts > 0,
                              "diff": "".join(l if l.endswith("\n") else l + "\n\\ No newline at end of file\n" for l in lines)})
            return {**result, "diffs": diffs}
    except EnvError as e:
        return {"ok": False, "command": command, "error": e.message, "code": e.code}
    except OSError as e:
        return {"ok": False, "command": command, "error": str(e)}
    return {"ok": False, "command": command, "error": "unreachable"}


_STATE_TEXT = {
    "env-only": "env-only: only the user's env edits, nothing to commit",
    "new changes": "new changes: stage them with env.stage(paths)",
    "conflict": "conflict: new edits touch the env lines, so stage can't split them. Leave the file out or ask the user",
    "staged-unsafe": "staged-unsafe: env edits are in the index. Unstage with git reset -q -- <path>",
    "no snapshot": "no snapshot: the whole file stays out of commits",
    "no snapshot (.gitattributes)": "no snapshot: .gitattributes don't let git merge it as text, so the whole file stays out of commits",
}


def _describe(path: str, states: list[str]) -> str:
    text = "; ".join(_STATE_TEXT[s].replace("<path>", path) for s in states)
    return f"  {path}  [{', '.join(states)}]  {text}"


def format_result(res: dict) -> str:
    if not res.get("ok"):
        return f"ERROR: {res.get('error')}"
    cmd = res["command"]
    out: list[str] = []
    if res.get("invalid"):
        out.append(f"Skipped (not a file path in {res['root']}): {', '.join(res['invalid'])}")
    if cmd in ("list", "check"):
        entries = res["entries"]
        out.append(f"Env files (Satura Space list at {res['file']}): {len(entries)}")
        if cmd == "list":
            if not entries:
                out.append("None. Nothing has to be left out of a commit.")
            out.extend(_describe(e, res["states"][e]) for e in entries)
        else:
            for c in res["checked"]:
                if c["env"]:
                    out.append(_describe(c["path"], c["states"]) + ". Don't git add it")
                else:
                    out.append(f"  {c['path']}  [not an env file]  git add is fine")
        if entries:
            out.append("Never git add, git add -A, git add . or git commit -a over env files. Name files explicitly, "
                       "and use env.stage(paths) for env files with new changes.")
    elif cmd == "add":
        if not res["added"]:
            out.append("Nothing added: every path is already an env file.")
        else:
            snap = set(res["snapshotted"])
            for p in res["added"]:
                out.append(f"  {p}: added; " + ("env edits saved, so stage will take only its new lines" if p in snap
                                                  else "whole file stays out of commits"))
    elif cmd == "remove":
        for p in res.get("notEnv", []):
            out.append(f"  {p}: not an env file")
        for p in res["removed"]:
            out.append(f"  {p}: removed; git treats it as a normal file again")
    elif cmd == "keep":
        for p in res.get("notEnv", []):
            out.append(f"  {p}: not an env file")
        snap = set(res["snapshotted"])
        for p in res["kept"]:
            out.append(f"  {p}: " + ("current edits are now env edits" if p in snap else "no snapshot, whole file stays out of commits"))
    elif cmd == "stage":
        stripped = set(res["strippedEnv"])
        for p in res["staged"]:
            out.append(f"  {p}: " + ("staged the new lines only, env edits left out" if p in stripped else "staged"))
        out.append("The working files are unchanged." if res["workingUntouched"] else "WARNING: a working file changed while staging.")
    elif cmd == "diff":
        for d in res["diffs"]:
            if not d["env"]:
                out.append(f"{d['path']}: not an env file, use git diff")
            elif not d["snapshot"]:
                out.append(f"{d['path']}: env file with no snapshot, the whole file stays out of commits")
            elif not d["diff"]:
                out.append(f"{d['path']}: no new changes, only env edits")
            else:
                if d["conflict"]:
                    out.append(f"{d['path']}: conflict, stage refuses this file")
                out.append(d["diff"].rstrip("\n"))
    return "\n".join(out)


@tool_guard
async def satura_env_files(
    command: Annotated[Literal["list", "check", "diff", "stage", "add", "remove", "keep"], Field(description="What to do, see the list above.")],
    paths: Annotated[list[str] | None, Field(description="Files for every command except list, relative to the repo root (as git status prints them) or absolute.")] = None,
    project_root: Annotated[str, Field(description="The project or worktree root. Leave empty for this project.")] = "",
) -> str:
    root = resolve_root(project_root)
    if not os.path.isdir(root):
        return f"ERROR: project_root is not a directory: {root}"
    return format_result(await asyncio.to_thread(env_exec, root, command, paths))
