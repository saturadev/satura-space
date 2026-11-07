"""Single headless-editor lifecycle for the Unity project this MCP server runs in.

Model: one Claude instance == one Unity project == one headless "build server"
editor (`Unity -batchmode -nographics … ` launched WITHOUT `-quit`). There is no global
registry — per-project state is the project's own `.mcp_status.json` (heartbeat,
written by MCPTestBridge with pid+isBatchMode) plus a `.mcp_editor.pid` file.

Imports only `helpers` + stdlib at module load; `modal_status` and `scratchpads`
are imported lazily at call time to keep module loading acyclic.
"""
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from . import helpers
from . import proc_identity as ident
from .control_client import write_trigger
from .constants import _STATUS_STALE_THRESHOLD
from .sspace import ensure_sspace

_DEFAULT_LAUNCH_TIMEOUT = 90
_DEFAULT_IDLE_QUIT = int(os.environ.get("UNITY_MCP_IDLE_QUIT", "600"))
_INLINE_OPT = "--optimize=-inline"


def _mono_inline_disabled_env() -> dict:
    env = dict(os.environ)
    if env.get("SATURA_KEEP_MONO_INLINE") == "1":
        return env
    existing = (env.get("MONO_ENV_OPTIONS") or "").strip()
    if existing and _INLINE_OPT not in existing:
        env["MONO_ENV_OPTIONS"] = f"{existing} {_INLINE_OPT}"
    elif not existing:
        env["MONO_ENV_OPTIONS"] = _INLINE_OPT
    env["MONO_INLINELIMIT"] = "0"
    return env

def _root(project_root: str = "") -> Path:
    return Path(os.path.abspath(os.path.expanduser(project_root or helpers.default_root())))

def _read_json(path: Path) -> dict | None:
    attempts = 5 if sys.platform == "win32" else 1
    for attempt in range(attempts):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (PermissionError, json.JSONDecodeError):
            if attempt + 1 < attempts:
                time.sleep(0.03)
        except Exception:
            return None
    return None

def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    tmp.replace(path)

def _read_status(root: Path) -> dict | None:
    return _read_json(root / ".sspace" / ".mcp_status.json")

def _read_pid_record(root: Path) -> dict | None:
    path = root / ".sspace" / ".mcp_editor.pid"
    try:
        text = path.read_text().strip()
        written = path.stat().st_mtime
        data = json.loads(text)
    except (OSError, ValueError):
        return None
    if isinstance(data, dict):
        pid, start = data.get("pid"), data.get("start")
    else:
        pid, start = data, None
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return None
    if isinstance(start, bool) or not isinstance(start, (int, float)):
        start = None
    return {"pid": pid, "start": start, "written": written}

def _write_pid(root: Path, pid: int, start: float | None = None) -> None:
    try:
        ensure_sspace(root)
        (root / ".sspace" / ".mcp_editor.pid").write_text(json.dumps({"pid": pid, "start": start}))
    except OSError:
        pass

def _clear_pid(root: Path) -> None:
    try:
        (root / ".sspace" / ".mcp_editor.pid").unlink()
    except OSError:
        pass

VALID_MODES = ("headless-nographics", "headless-graphics")

def _mode_file(root: Path) -> Path:
    return root / ".sspace" / ".mcp_editor.mode.json"

def _write_mode(root: Path, pid: int, mode: str, start: float | None = None) -> None:
    try:
        ensure_sspace(root)
        _mode_file(root).write_text(json.dumps({"pid": pid, "mode": mode, "start": start}))
    except OSError:
        pass

def _clear_mode(root: Path) -> None:
    try:
        _mode_file(root).unlink()
    except OSError:
        pass

def read_mode(project_root: str = "") -> str | None:
    """The graphics mode this MCP launched the project's editor with, or None when the
    live editor was launched elsewhere (orchestrator/GUI) or the record is stale."""
    root = _root(project_root)
    data = _read_json(_mode_file(root))
    if not data:
        return None
    pid = _editor_pid(root)
    if not pid or data.get("pid") != pid:
        return None
    start = data.get("start")
    if isinstance(start, (int, float)) and ident.check(pid, ident.is_unity_editor, start=start) == ident.NO:
        return None
    return data.get("mode")

def _winhook_path() -> str:
    """The macOS window-hiding/dialog-detecting dylib, resolved for both layouts:
    packaged (Resources/mcp/ and Resources/winhook/ are siblings) and dev (repo tree).
    Empty string = launch without injection (a degradation, never a failure)."""
    if sys.platform != "darwin" or os.environ.get("SATURA_DISABLE_WINHOOK") == "1":
        return ""
    if getattr(sys, "frozen", False):
        p = Path(sys.executable).resolve().parent.parent / "winhook" / "winhook.dylib"
    else:
        p = Path(__file__).resolve().parents[3] / "apps" / "orchestrator" / "resources" / "winhook" / "winhook.dylib"
    return str(p) if p.is_file() else ""

def _editor_launch_args(editor: str, root: Path, logf: Path, mode: str, idle: int) -> list[str]:
    cmd = [editor]
    if sys.platform == "win32" and mode == "headless-graphics":
        cmd.append("-force-d3d11")
    cmd.append("-batchmode")
    if mode == "headless-nographics":
        cmd.append("-nographics")
    cmd += ["-accept-apiupdate", "-debugCodeOptimization",
            "-projectPath", str(root), "-logFile", str(logf)]
    if idle > 0:
        cmd += ["-mcpIdleQuit", str(idle)]
    return cmd

def _editor_launch_env(root: Path, mode: str) -> dict:
    env = _mono_inline_disabled_env()
    if mode != "headless-graphics" or sys.platform != "darwin":
        return env
    hook = _winhook_path()
    if not hook:
        return env
    env["DYLD_INSERT_LIBRARIES"] = hook
    env["SATURA_MODAL_STATUS_FILE"] = str(root / ".sspace" / ".modal_status.json")
    env["SATURA_MODAL_CMD_FILE"] = str(root / ".sspace" / ".modal_cmd.json")
    return env

def _clear_modal_files(root: Path) -> None:
    for name in (".modal_status.json", ".modal_status.json.tmp",
                 ".modal_cmd.json", ".modal_cmd.json.tmp"):
        try:
            (root / ".sspace" / name).unlink()
        except OSError:
            pass

def _project_version(root: Path) -> str:
    try:
        for line in (root / "ProjectSettings" / "ProjectVersion.txt").read_text().splitlines():
            if line.startswith("m_EditorVersion:"):
                return line.split(":", 1)[1].strip()
    except Exception:
        pass
    return ""

def _default_editor_path(root: Path, version: str = "") -> str:
    ver = version or _project_version(root)
    if not ver:
        return ""
    if sys.platform == "win32":
        program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        return str(Path(program_files) / "Unity" / "Hub" / "Editor" / ver / "Editor" / "Unity.exe")
    return f"/Applications/Unity/Hub/Editor/{ver}/Unity.app/Contents/MacOS/Unity"

def _compile_errors_from_log(logf: Path, limit: int = 12) -> str:
    """Distinct C# compiler-error lines from a Unity editor log, newest content wins; '' if none."""
    try:
        text = logf.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    seen: list[str] = []
    for line in text.splitlines():
        if ": error CS" not in line or "_MCPExec_" in line:
            continue
        line = line.strip()
        if line not in seen:
            seen.append(line)
    if not seen:
        return ""
    shown = seen[:limit]
    if len(seen) > len(shown):
        shown.append(f"... and {len(seen) - len(shown)} more (see {logf})")
    return "\n".join(shown)

def compile_error_summary(project_root: str = "") -> tuple[int, str]:
    """Current compile errors as reported by the engine bridge: (count, first line).

    The engine writes ``.sspace/.mcp_compile_errors.log`` on every compilation that fails and deletes
    it when a compilation succeeds, so the file's presence is the live truth — (0, '') means the last
    compile was clean (or the editor predates the capture)."""
    root = _root(project_root)
    try:
        text = (root / ".sspace" / ".mcp_compile_errors.log").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return 0, ""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return 0, ""
    return len(lines), lines[0]

def bridge_down_hint(project_root: str = "") -> str:
    """A hint appended to no-progress stalls when the editor's boot log shows it can never consume
    commands: script compile errors at startup put a GUI editor in Safe Mode (the engine bridge is not
    loaded there) and make a batchmode editor exit — either way the command queue is dead, not slow."""
    root = _root(project_root)
    logs = []
    for name in (".mcp_editor.log", ".mcp_rawstream_editor.log"):
        logf = root / ".sspace" / name
        try:
            mtime = logf.stat().st_mtime
        except OSError:
            continue
        if time.time() - mtime > 6 * 3600:
            continue
        logs.append((mtime, logf))
    for _, logf in sorted(logs, reverse=True):
        name = logf.name
        try:
            text = logf.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if "ChangeMode(safe_mode)" not in text and "Scripts have compiler errors" not in text:
            continue
        hint = (
            "\nThe editor booted with SCRIPT COMPILE ERRORS (Safe Mode for a GUI editor, exit for a "
            "batchmode one) — the Satura Space bridge is not loaded, so no command can ever be "
            "consumed. Fix the errors, then unity.relaunch()."
        )
        errors = _compile_errors_from_log(logf)
        if errors:
            hint += "\nCompiler errors from " + name + ":\n" + errors
        return hint
    return ""

def _is_zombie(pid) -> bool:
    """True if pid is a not-yet-reaped zombie (still answers kill(0) but is dead).
    Windows has no zombie state, so this is always False there."""
    if sys.platform == "win32":
        return False
    try:
        out = subprocess.run(["ps", "-o", "state=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=3).stdout.strip()
        return out.startswith("Z")
    except Exception:
        return False

def _alive(pid) -> bool:
    """Robust liveness: reaps our own exited children (zombies) and treats any
    zombie as dead. The editor is launched as a child of this MCP process, so on
    exit it zombifies until reaped — plain os.kill(pid,0) would call that 'alive'."""
    if not pid:
        return False
    pid = int(pid)
    try:
        wpid, _ = os.waitpid(pid, os.WNOHANG)
        if wpid == pid:
            return False
    except ChildProcessError:
        pass
    except Exception:
        pass
    if not helpers.pid_alive(pid):
        return False
    return not _is_zombie(pid)

LOCK_FREE = "free"
LOCK_HELD = "held"
LOCK_UNKNOWN = "unknown"

def _lockfile_state(root: Path) -> tuple[str, int | None]:
    lock = root / "Temp" / "UnityLockfile"
    if not lock.exists():
        return LOCK_FREE, None
    if sys.platform == "win32":
        return LOCK_UNKNOWN, None
    try:
        out = subprocess.run(["lsof", "-t", "--", str(lock)],
                             capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError, ValueError):
        return LOCK_UNKNOWN, None
    toks = out.stdout.split()
    if not all(t.isdigit() for t in toks):
        return LOCK_UNKNOWN, None
    if out.returncode == 0 and toks:
        for tok in toks:
            if _alive(int(tok)):
                return LOCK_HELD, int(tok)
        return LOCK_FREE, None
    if out.returncode == 1 and not toks and not out.stderr.strip():
        return LOCK_FREE, None
    if not lock.exists():
        return LOCK_FREE, None
    return LOCK_UNKNOWN, None

def _unlink_stale_lockfile(root: Path) -> bool:
    lock = root / "Temp" / "UnityLockfile"
    if not lock.exists():
        return True
    if sys.platform != "win32" and _lockfile_state(root)[0] != LOCK_FREE:
        return False
    try:
        lock.unlink()
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return True

def _resolve_editor(root: Path, status: dict | None) -> dict | None:
    st = status or {}
    spid = st.get("pid") if isinstance(st.get("pid"), int) else None
    unverified = None
    if spid and _alive(spid):
        v, info = ident.verdict(spid, ident.is_unity_editor, written_at=st.get("timestamp"))
        if v == ident.YES:
            return {"pid": spid, "start": info.start, "status": True, "batch": st.get("isBatchMode")}
        if v == ident.UNKNOWN:
            unverified = spid
    rec = _read_pid_record(root)
    if rec and rec["pid"] != unverified and _alive(rec["pid"]):
        v, info = ident.verdict(rec["pid"], ident.is_unity_editor, start=rec["start"],
                                written_at=None if rec["start"] is not None else rec["written"])
        if v == ident.YES:
            return {"pid": rec["pid"], "start": info.start, "status": False, "batch": True}
        if v == ident.UNKNOWN and unverified is None:
            unverified = rec["pid"]
    _, owner = _lockfile_state(root)
    if owner and owner != unverified:
        v, info = ident.verdict(owner, ident.is_unity_editor)
        if v == ident.YES:
            return {"pid": owner, "start": info.start, "status": False, "batch": None}
        if v == ident.UNKNOWN and unverified is None:
            unverified = owner
    if unverified:
        return {"pid": unverified, "start": None, "status": unverified == spid, "batch": None, "unverified": True}
    return None

def _editor_pid(root: Path) -> int | None:
    return (_resolve_editor(root, _read_status(root)) or {}).get("pid")

def editor_health(project_root: str = "") -> dict:
    """RUNNING (status fresh) / BUSY (stale but pid alive — compiling/building/arming) / DOWN."""
    root = _root(project_root)
    status = _read_status(root)
    return _health(root, status, _resolve_editor(root, status))

def _health(root: Path, status: dict | None, ed: dict | None) -> dict:
    if not ed:
        return {"state": "DOWN", "pid": None, "root": str(root)}
    st = status if ed["status"] and status else {}
    fresh = bool(st) and abs(time.time() - st.get("timestamp", 0)) <= _STATUS_STALE_THRESHOLD
    health = {
        "state": "RUNNING" if fresh else "BUSY",
        "pid": ed["pid"],
        "root": str(root),
        "isPlaying": st.get("isPlaying"),
        "isPaused": st.get("isPaused"),
        "isCompiling": st.get("isCompiling"),
        "isBatchMode": None if ed.get("unverified") else ed["batch"],
        "activeScene": st.get("activeScene"),
        "activeSceneName": st.get("activeSceneName"),
        "scenesDirty": st.get("scenesDirty"),
        "scenes": st.get("scenes") or [],
    }
    if ed.get("unverified"):
        health["unverified"] = True
    if st.get("isStreaming"):
        health["streamActualFps"] = st.get("streamActualFps")
        health["streamRes"] = st.get("streamRes")
    return health

def kill_refusal(health: dict) -> str | None:
    pid = health.get("pid")
    if health.get("state") == "DOWN" or not pid:
        return None
    if health.get("isBatchMode") is True:
        return None
    if health.get("isBatchMode") is False:
        return (f"A GUI Unity editor (pid {pid}) holds this project — refusing to kill it. "
                "Close it yourself if that's really what you want.")
    if health.get("unverified"):
        why = "its process couldn't be checked (the process lookup failed or timed out)"
    else:
        why = ("its .mcp_status.json was written by another process (or is missing), so nothing proves it "
               "is a headless batchmode editor")
    return (f"A Unity editor (pid {pid}) holds this project but {why} — it may be the user's own editor, "
            "so refusing to kill or relaunch it. Check unity.status() again in a moment; if it stays like "
            "this, ask the user to close that editor.")

HUB_NOT_RUNNING = ("Unity Hub isn't running, and Unity can't check its license without it. "
                   "Ask the user to start Unity Hub, then try again.")


def unity_hub_running() -> bool:
    forced = "" if getattr(sys, "frozen", False) else os.environ.get("SATURA_DEV_HUB_STATE", "")
    if forced:
        return forced == "ready"
    try:
        if sys.platform == "darwin":
            return subprocess.run(["pgrep", "-x", "Unity Hub"], capture_output=True, timeout=3).returncode == 0
        if sys.platform == "win32":
            out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq Unity Hub.exe", "/NH", "/FO", "CSV"],
                                 capture_output=True, text=True, timeout=4,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
            return '"unity hub.exe"' in out.lower()
    except (OSError, subprocess.SubprocessError):
        return True
    return True


def ensure_editor(project_root: str = "", editor_path: str = "", version: str = "",
                  timeout: int = _DEFAULT_LAUNCH_TIMEOUT, idle_quit_seconds: int = None,
                  mode: str = "") -> dict:
    """Reuse the project's headless editor, or lazily launch one (detached).

    idle_quit_seconds: headless editor self-quits after this many idle seconds
    (default _DEFAULT_IDLE_QUIT; 0 disables).
    mode: '' (default — reuse any running editor regardless of its graphics mode,
    spawn headless-nographics when none runs), 'headless-nographics' (batchmode
    without a graphics device — cheapest) or 'headless-graphics' (batchmode with a
    real GPU device — screenshots/camera captures work; on macOS the dialog-detecting
    hook is injected). An explicitly requested mode never kills a live editor in the
    other mode — the mismatch is returned as an error."""
    if mode and mode not in VALID_MODES:
        return {"ok": False, "error": f"Invalid mode '{mode}'. Use one of: {', '.join(VALID_MODES)}."}
    root = _root(project_root)
    if not (root / "Assets").is_dir():
        return {"ok": False, "error": f"Not a Unity project: {root}"}

    from . import scratchpads

    if scratchpads.is_scratchpad_path(root):
        return {"ok": False, "error": (
            f"{root} is a scratchpad — the Satura Space app runs its editor so the user can watch it. "
            "Start it with scratchpad.start(id) instead.")}

    health = editor_health(str(root))
    if health["state"] in ("RUNNING", "BUSY"):
        recorded = read_mode(str(root))
        if mode and recorded and recorded != mode:
            return {"ok": False, "running_mode": recorded, "error": (
                f"An editor is already running at {root} in mode '{recorded}' "
                f"(pid {health.get('pid')}). Shut it down first (unity.shutdown()) to "
                f"relaunch as '{mode}'.")}
        if health.get("isBatchMode") is True:
            helpers.mark_headless(str(root))
        result = {"ok": True, "reused": True, "mode": recorded, **health}
        if recorded is None and mode == "headless-graphics":
            result["mode_note"] = (
                "the running editor's graphics mode is unrecorded — screenshot/camera "
                "tools will refuse if it was launched with -nographics")
        return result

    from .input_gate import refusal
    refused = refusal(root)
    if refused:
        return {"ok": False, "error": refused}

    from .multiplayer import orchestrator_hub_blocked
    hub = orchestrator_hub_blocked(str(root))
    if hub or not unity_hub_running():
        return {"ok": False, "error": hub or HUB_NOT_RUNNING}

    lock_state, owner = _lockfile_state(root)
    if owner:
        return {"ok": False, "error": (
            f"An editor (pid {owner}) already owns {root} but its heartbeat is gone. "
            "If it's a GUI editor, use it; otherwise close it before launching headless.")}
    if lock_state == LOCK_UNKNOWN and sys.platform != "win32":
        return {"ok": False, "error": (
            f"{root / 'Temp' / 'UnityLockfile'} exists and its owner couldn't be checked (lsof failed or "
            "timed out), so a Unity editor may still have this project open. Not starting a second editor "
            "on it. Retry; if it keeps failing, ask the user whether a Unity editor has the project open.")}
    if not _unlink_stale_lockfile(root):
        return {"ok": False, "error": (
            f"Couldn't remove the stale {root / 'Temp' / 'UnityLockfile'}; an editor may still hold it. "
            "Ask the user whether a Unity editor has the project open.")}

    try:
        (root / ".sspace" / ".mcp_quit_trigger.json").unlink()
    except OSError:
        pass

    editor = editor_path or _default_editor_path(root, version)
    if not editor or not Path(editor).exists():
        want = version or _project_version(root)
        if not editor_path and want:
            return {"ok": False, "error": (
                f"This project needs Unity {want}, which isn't installed ({editor} is missing). "
                "Ask the user to install it in Unity Hub, then call unity.relaunch() again. "
                "Opening the project in Satura Space's Unity panel shows an Install button, and there "
                "unity.relaunch() waits for the install by itself.")}
        return {"ok": False, "error": (
            f"Unity editor binary not found: {editor or '(unresolved from ProjectVersion.txt)'}. "
            "Check ProjectSettings/ProjectVersion.txt.")}

    logf = root / ".sspace" / ".mcp_editor.log"
    idle = _DEFAULT_IDLE_QUIT if idle_quit_seconds is None else int(idle_quit_seconds)
    launch_mode = mode or "headless-nographics"
    cmd = _editor_launch_args(editor, root, logf, launch_mode, idle)
    env = _editor_launch_env(root, launch_mode)
    hook_note = ""
    if launch_mode == "headless-graphics":
        _clear_modal_files(root)
        if sys.platform == "darwin" and "DYLD_INSERT_LIBRARIES" not in env:
            if os.environ.get("SATURA_DISABLE_WINHOOK") == "1":
                hook_note = "winhook disabled by SATURA_DISABLE_WINHOOK — modal dialogs won't be auto-detected for this editor"
            else:
                hook_note = "winhook.dylib not found — modal dialogs won't be auto-detected for this editor"
        elif sys.platform == "win32":
            hook_note = "hook injection is unavailable from the MCP on Windows — modal dialogs won't be auto-detected for this editor"
    started = time.time()
    if sys.platform == "win32":
        detach_kwargs = {"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
    else:
        detach_kwargs = {"start_new_session": True}
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env=env,
        **detach_kwargs,
    )
    start = ident.start_time(proc.pid)
    _write_pid(root, proc.pid, start)
    _write_mode(root, proc.pid, launch_mode, start)
    helpers.mark_headless(str(root))

    from . import modal_status

    deadline = time.time() + timeout
    dialog_hits = 0
    dialogs_resolved: list[str] = []
    while time.time() < deadline:
        time.sleep(1.0)
        if proc.poll() is not None:
            _clear_pid(root)
            _clear_mode(root)
            helpers.unmark_headless(str(root))
            err = f"Editor exited during launch (code {proc.returncode}). See {logf}"
            errors = _compile_errors_from_log(logf)
            if errors:
                err += (
                    "\nScript compile errors abort a batchmode editor at boot (it exits instead of "
                    "entering Safe Mode). Fix these, then retry:\n" + errors
                )
            return {"ok": False, "error": err}
        dialogs = modal_status.active_dialogs(root)
        if dialogs:
            dialog_hits += 1
            for d in dialogs:
                title = d.get("title") or "<untitled>"
                if title not in dialogs_resolved:
                    dialogs_resolved.append(title)
            if dialog_hits >= 2:
                return {
                    "ok": False,
                    "error": "the launching editor raised a modal dialog and cannot finish starting",
                    "dialog_block": modal_status.dialog_block(root, dialogs),
                    "pid": proc.pid,
                }
        else:
            dialog_hits = 0
        status = _read_status(root)
        if (status and status.get("pid") == proc.pid
                and abs(time.time() - status.get("timestamp", 0)) <= _STATUS_STALE_THRESHOLD):
            result = {"ok": True, "reused": False, "pid": proc.pid, "state": "RUNNING",
                      "mode": launch_mode, "armed_seconds": round(time.time() - started, 1)}
            if hook_note:
                result["hook_note"] = hook_note
            if dialogs_resolved:
                result["dialog_note"] = (
                    "A modal dialog appeared during launch and was resolved before completion: "
                    + ", ".join(f"'{t}'" for t in dialogs_resolved) + "."
                )
            return result
    return {"ok": False, "error": f"Editor did not arm within {timeout}s. See {logf}", "pid": proc.pid}

def shutdown(project_root: str = "", force: bool = False, timeout: int = 30) -> dict:
    """Stop the project's headless editor.

    Sends .mcp_quit_trigger.json -> EditorApplication.Exit(0), which flushes the
    AssetDatabase and releases the lockfile cleanly. Heavy editors can then spend
    tens of seconds in mono/debugger teardown while still holding the process; for
    a build server (no unsaved asset edits) killing that lingering process is safe,
    so after a short graceful window we escalate SIGTERM -> SIGKILL and clear any
    stale lockfile. `force=True` skips straight to the kill.
    """
    root = _root(project_root)
    status = _read_status(root)
    ed = _resolve_editor(root, status)
    health = _health(root, status, ed)
    pid = health.get("pid")
    if not pid:
        _post_shutdown(root)
        return {"ok": True, "message": "No editor running."}
    refused = kill_refusal(health)
    if refused:
        return {"ok": False, "refused": True, "message": refused}
    start = ed["start"]
    v = ident.check(pid, ident.is_unity_editor, start=start, fresh=True)
    if v == ident.NO:
        _post_shutdown(root)
        return {"ok": True, "message": f"Editor {pid} had already exited."}
    if v != ident.YES:
        return {"ok": False, "refused": True, "message": kill_refusal({**health, "isBatchMode": None, "unverified": True})}

    def same() -> bool:
        return _alive(pid) and ident.check(pid, ident.is_unity_editor, start=start, fresh=True) != ident.NO

    if not force:
        write_trigger(root, ".mcp_quit_trigger.json", "{}")
        deadline = time.time() + min(timeout, 15)
        while time.time() < deadline:
            time.sleep(0.5)
            if not same():
                _post_shutdown(root)
                return {"ok": True, "message": f"Editor {pid} quit gracefully."}

    quit_requested = not force
    if sys.platform == "win32":
        stages = ((signal.SIGTERM, 7),)
    else:
        stages = ((signal.SIGTERM, 4), (signal.SIGKILL, 3))
    for sig, wait in stages:
        if ident.check(pid, ident.is_unity_editor, start=start, fresh=True) != ident.YES:
            break
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            break
        except Exception:
            pass
        end = time.time() + wait
        while time.time() < end and same():
            time.sleep(0.3)
        if not same():
            break

    dead = not same()
    cleared = dead and _unlink_stale_lockfile(root)
    if dead:
        _post_shutdown(root)
    how = ("quit requested; lingering teardown process killed" if quit_requested
           else "killed (forced)")
    if not dead:
        return {"ok": False, "message": f"Editor {pid} is still running after the kill; lockfile left in place."}
    tail = "lockfile cleared" if cleared else "lockfile left in place"
    return {"ok": True, "message": f"Editor {pid} {how}; {tail}."}

def _post_shutdown(root: Path) -> None:
    try:
        (root / ".sspace" / ".mcp_quit_trigger.json").unlink()
    except OSError:
        pass
    helpers.unmark_headless(str(root))
    _clear_pid(root)
    _clear_mode(root)
