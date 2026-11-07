import functools
import inspect
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from . import version_guard

_unity_pid_cache: dict[str, int] = {}

_headless_roots: set[str] = set()

def _norm(project_root: str) -> str:
    return os.path.abspath(os.path.expanduser(project_root)) if project_root else ""

_PROJECT_ROOT_ENV = "SATURA_MCP_PROJECT_ROOT"

def locked_root() -> str | None:
    """The project this MCP is HARD-LOCKED to (standalone-editor mode), or None
    when it may serve any project (multi-project mode)."""
    p = os.environ.get(_PROJECT_ROOT_ENV)
    return os.path.abspath(os.path.expanduser(p)) if p else None

def default_root() -> str:
    """Project a tool uses when the caller names none: the locked project in
    standalone mode, else the server's working directory."""
    return locked_root() or os.path.abspath(os.getcwd())

def resolve_root(project_root: str) -> str:
    """Canonical absolute root for a tool call — the caller's project_root when
    given (multi-project), else the default."""
    return os.path.abspath(os.path.expanduser(project_root)) if project_root else default_root()

def path_within(child: str, parent: str) -> bool:
    """True when child RESOLVES to parent itself or somewhere nested under it.
    Realpath comparison makes /var vs /private/var aliases agree while rejecting
    symlinks inside the parent that point outside it."""
    a = os.path.normcase(os.path.normpath(os.path.realpath(parent)))
    b = os.path.normcase(os.path.normpath(os.path.realpath(child)))
    return b == a or b.startswith(a + os.sep)

def tool_guard(fn):
    """The preconditions every MCP tool passes before its body runs.

    PROJECT LOCK — in standalone-editor mode, refuse any tool call whose project_root points outside
    the locked project. Paths INSIDE the locked project (scratchpads under
    .sspace/scratchpads) are allowed. In multi-project mode this is a no-op, so every tool can
    freely target another project. Checked first, so the version check never reads markers out of a
    project this server is forbidden to touch.

    VERSION — refuse once Satura Space has moved past this server, which cannot reload itself; see
    version_guard."""
    sig = inspect.signature(fn)

    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        try:
            pr = sig.bind_partial(*args, **kwargs).arguments.get("project_root", "") or ""
        except TypeError:
            pr = ""
        locked = locked_root()
        if locked and pr and not path_within(os.path.abspath(os.path.expanduser(pr)), locked):
            return (
                "ERROR: This Satura Space MCP is locked to a single project "
                "(standalone editor mode):\n"
                f"  {locked}\n"
                "It refuses to operate on a different project:\n"
                f"  {os.path.abspath(os.path.expanduser(pr))}\n"
                "Leave project_root empty — it defaults to the locked project."
            )
        stale = version_guard.stale_message(resolve_root(pr))
        if stale:
            return stale
        return await fn(*args, **kwargs)

    wrapper.__signature__ = sig
    wrapper.__satura_guarded__ = True
    return wrapper

def mark_headless(project_root: str) -> None:
    n = _norm(project_root)
    if n:
        _headless_roots.add(n)

def unmark_headless(project_root: str) -> None:
    _headless_roots.discard(_norm(project_root))

def _status_is_batchmode(project_root: str) -> bool:
    """Read .mcp_status.json directly (no tools_bridge import) for the isBatchMode flag."""
    try:
        data = json.loads((Path(_norm(project_root)) / ".sspace" / ".mcp_status.json").read_text())
        return bool(data.get("isBatchMode", False))
    except Exception:
        return False

def is_headless(project_root: str) -> bool:
    n = _norm(project_root)
    if not n:
        return False
    return n in _headless_roots or _status_is_batchmode(n)

def _pid_alive_windows(pid: int) -> bool:
    """Read-only liveness on Windows. os.kill(pid, 0) is unusable here: Python maps
    os.kill to TerminateProcess, so any signal value can KILL the target and never
    reports liveness reliably. We OpenProcess with the least privilege that any
    caller can get (QUERY_LIMITED_INFORMATION) and read the exit code instead."""
    import ctypes
    from ctypes import wintypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    ERROR_ACCESS_DENIED = 5

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        err = ctypes.get_last_error()
        return err == ERROR_ACCESS_DENIED
    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return True
        return code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def pid_alive(pid) -> bool:
    if not pid:
        return False
    pid = int(pid)
    if sys.platform == "win32":
        try:
            return _pid_alive_windows(pid)
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return False

def _focus_unity(project_root: str = ""):
    """Bring the Unity Editor for a specific project to front (macOS; no-op elsewhere)."""
    if not project_root:
        return
    if is_headless(project_root):
        return
    if sys.platform != "darwin":
        return
    try:
        _focus_unity_macos(project_root)
    except Exception:
        pass

def _is_unity_editor_cmd(cmd: str) -> bool:
    """True if a ps command line is a GUI Unity Editor process.

    Excludes Unity Hub (and its helpers), the licensing client, and
    batch-mode background processes such as AssetImportWorkers — all of
    which have names starting with "Unity" but must never be focused.
    """
    if "MacOS/Unity" not in cmd or "Unity Hub" in cmd:
        return False
    low = cmd.lower()
    return "-batchmode" not in low and "assetimportworker" not in low

def _same_path(a: str, b: str) -> bool:
    try:
        return os.path.samefile(a, b)
    except OSError:
        return os.path.normpath(os.path.realpath(a)).casefold() == \
            os.path.normpath(os.path.realpath(b)).casefold()

def _unity_editor_pid_macos(project_root: str) -> int | None:
    """PID of the Unity Editor instance that has project_root open, or None."""
    cached = _unity_pid_cache.get(project_root)
    if cached:
        check = subprocess.run(
            ["ps", "-p", str(cached), "-o", "command="],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        if check and _is_unity_editor_cmd(check) and project_root.casefold() in check.casefold():
            return cached
        del _unity_pid_cache[project_root]

    out = subprocess.run(
        ["ps", "-axo", "pid=,command="],
        capture_output=True, text=True, timeout=5,
    ).stdout

    for line in out.splitlines():
        line = line.strip()
        m = re.match(r"(\d+)\s+(.*)", line)
        if not m:
            continue
        pid, cmd = int(m.group(1)), m.group(2)
        if not _is_unity_editor_cmd(cmd):
            continue
        pm = re.search(r"-projectpath\s+(.+?)(?=\s+-\S|$)", cmd, re.IGNORECASE)
        if pm and _same_path(pm.group(1).strip(), project_root):
            _unity_pid_cache[project_root] = pid
            return pid

    lockfile = Path(project_root) / "Temp" / "UnityLockfile"
    if lockfile.exists():
        out = subprocess.run(
            ["lsof", "-t", "--", str(lockfile)],
            capture_output=True, text=True, timeout=5,
        ).stdout
        for tok in out.split():
            if not tok.isdigit():
                continue
            pid = int(tok)
            cmd = subprocess.run(
                ["ps", "-p", str(pid), "-o", "command="],
                capture_output=True, text=True, timeout=5,
            ).stdout.strip()
            if _is_unity_editor_cmd(cmd):
                _unity_pid_cache[project_root] = pid
                return pid
    return None

def _focus_unity_macos(project_root: str):
    """Bring the Unity Editor window for project_root to front (macOS).

    Resolves the editor's PID first (via ps / lsof) and targets it by
    unix id, so other Unity instances — other projects,
    AssetImportWorkers, Unity Hub helpers — are never focused.
    Does nothing if no editor has this project open.

    Uses AppleScript via osascript.
    - Restores minimised windows via AXMinimized attribute.
    - Raises the first window via AXRaise so it actually appears.
    - Does NOT touch window size or position.
    """
    pid = _unity_editor_pid_macos(project_root)
    if pid is None:
        return
    script = (
        'tell application "System Events"\n'
        f'  set unityProcs to every process whose unix id is {pid}\n'
        '  if (count of unityProcs) = 0 then return\n'
        '  set unityProc to item 1 of unityProcs\n'
        '  tell unityProc\n'
        '    repeat with w in (every window)\n'
        '      try\n'
        '        if value of attribute "AXMinimized" of w is true then\n'
        '          set value of attribute "AXMinimized" of w to false\n'
        '        end if\n'
        '      end try\n'
        '    end repeat\n'
        '    set frontmost to true\n'
        '    try\n'
        '      perform action "AXRaise" of window 1\n'
        '    end try\n'
        '  end tell\n'
        'end tell'
    )
    subprocess.run(
        ["osascript", "-e", script],
        timeout=5, capture_output=True,
    )
