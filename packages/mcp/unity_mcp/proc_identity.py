import calendar
import os
import subprocess
import sys
import time
from dataclasses import dataclass

YES = "yes"
NO = "no"
UNKNOWN = "unknown"

START_TOLERANCE = 2.0
_CACHE_TTL = 1.0
_PS_TIMEOUT = 3

_UNITY_EXES = {"unity", "unity.exe"}
_ORCHESTRATOR_EXES = {"electron", "electron.exe", "satura space", "satura space.exe", "satura-space", "satura-space.exe"}


@dataclass(frozen=True)
class ProcInfo:
    pid: int
    start: float
    exe: str

    @property
    def name(self) -> str:
        return os.path.basename(self.exe.replace("\\", "/")).strip().lower()


_cache: dict[int, tuple[float, object]] = {}


def _parse_ps(out: str, pid: int):
    line = out.strip()
    parts = line.split(None, 5)
    if len(parts) < 6:
        return UNKNOWN
    try:
        start = calendar.timegm(time.strptime(" ".join(parts[:5]), "%a %b %d %H:%M:%S %Y"))
    except ValueError:
        return UNKNOWN
    return ProcInfo(pid, float(start), parts[5].strip())


def _query_posix(pid: int):
    env = dict(os.environ, TZ="UTC0", LC_ALL="C")
    try:
        r = subprocess.run(["ps", "-o", "lstart=,comm=", "-p", str(pid)],
                           capture_output=True, text=True, timeout=_PS_TIMEOUT, env=env)
    except (OSError, subprocess.SubprocessError):
        return UNKNOWN
    if r.returncode == 0 and r.stdout.strip():
        return _parse_ps(r.stdout, pid)
    if r.returncode == 1 and not r.stdout.strip():
        return None
    return UNKNOWN


def _query_windows(pid: int):
    import ctypes
    from ctypes import wintypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    ERROR_INVALID_PARAMETER = 87
    STILL_ACTIVE = 259
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return None if ctypes.get_last_error() == ERROR_INVALID_PARAMETER else UNKNOWN
    try:
        code = wintypes.DWORD()
        if k32.GetExitCodeProcess(h, ctypes.byref(code)) and code.value != STILL_ACTIVE:
            return None
        c, e, kt, ut = (wintypes.FILETIME() for _ in range(4))
        if not k32.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(e), ctypes.byref(kt), ctypes.byref(ut)):
            return UNKNOWN
        ticks = c.dwHighDateTime << 32 | c.dwLowDateTime
        start = (ticks - 116444736000000000) / 1e7
        buf = ctypes.create_unicode_buffer(32768)
        size = wintypes.DWORD(len(buf))
        if not k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return UNKNOWN
        return ProcInfo(pid, float(start), buf.value)
    finally:
        k32.CloseHandle(h)


def process_info(pid, fresh: bool = False):
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return None
    if pid <= 0:
        return None
    now = time.monotonic()
    hit = _cache.get(pid)
    if not fresh and hit and now - hit[0] < _CACHE_TTL:
        return hit[1]
    try:
        info = _query_windows(pid) if sys.platform == "win32" else _query_posix(pid)
    except Exception:
        info = UNKNOWN
    _cache[pid] = (now, info)
    return info


def is_unity_editor(info) -> bool:
    return isinstance(info, ProcInfo) and info.name in _UNITY_EXES


def is_orchestrator(info) -> bool:
    return isinstance(info, ProcInfo) and info.name in _ORCHESTRATOR_EXES


def matches(info, *, start: float | None = None, written_at: float | None = None) -> bool:
    if not isinstance(info, ProcInfo):
        return False
    if start is not None and abs(info.start - float(start)) > START_TOLERANCE:
        return False
    if written_at is not None and info.start > float(written_at) + START_TOLERANCE:
        return False
    return True


def verdict(pid, kind, *, start: float | None = None, written_at: float | None = None, fresh: bool = False):
    info = process_info(pid, fresh=fresh)
    if info is None:
        return NO, None
    if not isinstance(info, ProcInfo):
        return UNKNOWN, None
    if not kind(info) or not matches(info, start=start, written_at=written_at):
        return NO, info
    return YES, info


def check(pid, kind, *, start: float | None = None, written_at: float | None = None, fresh: bool = False):
    return verdict(pid, kind, start=start, written_at=written_at, fresh=fresh)[0]


def app_marker_trusted(pid, marker) -> bool:
    if not pid:
        return False
    try:
        written = marker.stat().st_mtime
    except (OSError, AttributeError):
        return False
    return check(pid, is_orchestrator, written_at=written) != NO


def start_time(pid):
    info = process_info(pid, fresh=True)
    return info.start if isinstance(info, ProcInfo) else None


def forget(pid) -> None:
    try:
        _cache.pop(int(pid), None)
    except (TypeError, ValueError):
        pass
