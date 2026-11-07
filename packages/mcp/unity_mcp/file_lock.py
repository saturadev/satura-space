import asyncio
import json
import os
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

from .helpers import pid_alive
from .sspace import ensure_sspace

if sys.platform == "win32":
    import msvcrt

    def _try_lock(fd) -> bool:
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False

    def _unlock(fd) -> None:
        try:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
else:
    import fcntl

    def _try_lock(fd) -> bool:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False

    def _unlock(fd) -> None:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass


def _owner_path(root: Path) -> Path:
    return root / ".sspace" / ".mcp_exec.lock.owner"


def _write_owner(root: Path, op: str) -> None:
    try:
        _owner_path(root).write_text(json.dumps({
            "pid": os.getpid(),
            "op": op,
            "since": time.time(),
        }))
    except OSError:
        pass


def _clear_owner(root: Path) -> None:
    try:
        _owner_path(root).unlink()
    except OSError:
        pass


def read_owner(root: Path) -> dict | None:
    try:
        return json.loads(_owner_path(root).read_text())
    except (OSError, json.JSONDecodeError):
        return None


def stale_holder(root: Path) -> dict | None:
    owner = read_owner(root)
    if owner is None:
        return None
    pid = owner.get("pid")
    if pid and not pid_alive(pid):
        return owner
    return None


@asynccontextmanager
async def project_editor_lock(root: Path, timeout: float, poll_interval: float = 0.25, op: str = "op"):
    ss = ensure_sspace(root)
    lock_path = ss / ".mcp_exec.lock"

    fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o644)
    acquired = False
    deadline = time.monotonic() + max(0.0, timeout)
    try:
        while True:
            if _try_lock(fd):
                acquired = True
                _write_owner(root, op)
                break
            if time.monotonic() >= deadline:
                break
            await asyncio.sleep(poll_interval)
        yield acquired
    finally:
        if acquired:
            _clear_owner(root)
            _unlock(fd)
        os.close(fd)

