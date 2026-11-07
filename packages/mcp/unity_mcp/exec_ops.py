import asyncio
import base64
import contextvars
import inspect
import json
import math
import re
import time
from pathlib import Path

from . import instances
from .helpers import resolve_root
from .multiplayer import STOPPED_NOTE, discover_players, no_editor_message, orchestrator_stopped, select_targets

FAIL_HEAD = re.compile(
    r"^((ERROR|TRACE_ERROR|EXEC ERROR|EXEC ABORTED|TIMEOUT|BLOCKED BY DIALOG|STOP FAILED|SCREENSHOT ERROR|SCREENSHOT ABORTED|"
    r"RELAUNCH FAILED|ARM HOT RELOAD FAILED|REFRESH ABORTED|INPUT SYSTEM REQUIRED)\b|BUSY:)"
)
FAIL_START = (
    "Unity is in Play Mode — refresh is not possible",
    "No Unity editor is open",
    "No Unity editor is running",
    "Unity Hub isn't running",
    "Unity is already compiling",
    "The editor acked the exec but produced no result file",
)
SAVED_NOTE = re.compile(r"\n*NOTE \(saved files\): (.*?)(?=\n\nNOTE|\Z)", re.S)
DIRTY_NOTE = re.compile(r"\n*NOTE \(unsaved changes\): (.+?) is now dirty.*", re.S)
COMPILE_WARNING = re.compile(r"^WARNING: project scripts have compile errors[^\n]*(?:\n\nCompiler errors:\n(.*?))?(?:\n\n|\Z)", re.S)
DEFAULT_HANDLE_WAIT = 60.0
RELAUNCH_MAX_WAIT = 3600
SLOW_EXEC_NOTE_SECONDS = 10.0
EXEC_SEEN: set[str] = set()
clock = time.monotonic
HANDLE_POLL = 0.25
HANDLE_POLL_MAX = 1.0
STOP_ON_CANCEL = 30.0
cleanup_notes: contextvars.ContextVar[list | None] = contextvars.ContextVar("cleanup_notes", default=None)


class OpError(Exception):
    def __init__(self, message: str, name: str = "UnityError"):
        super().__init__(message)
        self.name = name


def error_name(text: str) -> str:
    head = text.splitlines()[0] if text else ""
    if "INPUT SYSTEM REQUIRED" in head:
        return "InputSystemRequired"
    if "COMPILE ERRORS" in head or "compile error(s)" in head or head.startswith("EXEC ERROR") and "error CS" in text:
        return "CompileError"
    if head.startswith("BLOCKED BY DIALOG"):
        return "DialogBlocked"
    if head.startswith("TIMEOUT"):
        return "UnityTimeout"
    return "UnityError"


def failed(text: str) -> bool:
    head = (text or "").lstrip().splitlines()[0] if (text or "").strip() else ""
    return bool(FAIL_HEAD.match(head)) or "COMPILE ERRORS" in head or head.startswith(FAIL_START) or "Hot reload NOT armed" in (text or "") or "\nHEADLESS LAUNCH FAILED:" in f"\n{text or ''}"


def clean_error(text: str) -> str:
    t = (text or "").strip()
    for head in ("ERROR:", "EXEC ERROR:", "TRACE_ERROR:"):
        if t.startswith(head):
            return t[len(head):].strip()
    return t


def split_result(res) -> tuple[str, list[dict]]:
    if not isinstance(res, list):
        return str(res if res is not None else ""), []
    texts, images = [], []
    for item in res:
        if isinstance(item, str):
            texts.append(item)
            continue
        data = getattr(item, "data", None)
        path = getattr(item, "path", None)
        if data is None and path:
            try:
                data = Path(path).read_bytes()
            except OSError:
                data = None
        if data:
            images.append({"mime": getattr(item, "_mime_type", "image/png"), "data": base64.b64encode(data).decode()})
    return "\n".join(texts), images


def text_result(res, notes: list[str] | None = None) -> dict:
    text, images = split_result(res)
    if failed(text):
        raise OpError(clean_error(text), error_name(text))
    text = text.strip()
    if text.startswith("Exec completed."):
        text = text[len("Exec completed."):].strip()
        text = text[len("Output:"):].strip() if text.startswith("Output:") else text
        if text.startswith("TRACE_ERROR"):
            raise OpError(clean_error(text), "UnityError")
    out = {"value": text}
    if images:
        out["images"] = images
    if notes:
        out["notes"] = notes
    return out


def whole(args: dict, key: str, default: int, low: int = 0) -> int:
    v = args.get(key)
    if v is None or v == "":
        return default
    if isinstance(v, bool) or not isinstance(v, (int, float)) or isinstance(v, float) and not v.is_integer():
        raise OpError(f"{key} must be a whole number, got {v!r}", "TypeError")
    if v < low:
        raise OpError(f"{key} must be {low} or more, got {v!r}", "TypeError")
    return int(v)


def secs(args: dict, key: str, default: float) -> int:
    return max(1, math.ceil(num(args, key, default)))


def wait_secs(args: dict, default: float, notes: list[str]) -> int:
    from .editor_watch import MAX_WAIT_SECONDS, cap_note
    asked = secs(args, "timeout", default)
    note = cap_note(asked)
    if note and note not in notes:
        notes.append(note)
    return min(asked, MAX_WAIT_SECONDS)


def num(args: dict, key: str, default):
    v = args.get(key)
    if v is None or v == "":
        return default
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise OpError(f"{key} must be a number, got {v!r}", "TypeError")
    if math.isnan(f) or f <= 0:
        return default
    return f


def player_of(args: dict, default: str) -> str:
    p = args.get("player")
    if p is None or p == "":
        return default
    return str(p)


def parse_exec_text(text: str) -> tuple[str, list[str]]:
    notes = []
    m = DIRTY_NOTE.search(text)
    if m:
        notes.append(f"{m.group(1)} has unsaved changes. The user saves them. unity.openScene() or unity.play() on another scene refuses until you pass unsaved: 'save' or 'discard'.")
        text = text[: m.start()]
    m = SAVED_NOTE.search(text)
    if m:
        notes.insert(0, m.group(1)[0].upper() + m.group(1)[1:].strip())
        text = text[: m.start()] + text[m.end():]
    if text.startswith("Exec completed."):
        idx = text.find("\nOutput:\n")
        body = text[idx + len("\nOutput:\n"):].rstrip() if idx >= 0 else ""
        warned = COMPILE_WARNING.match(body)
        if warned:
            errors = [l for l in (warned.group(1) or "").splitlines() if l.strip()]
            shown = "; ".join(errors[:3]) + (f"; and {len(errors) - 3} more" if len(errors) > 3 else "")
            notes.append("The project has compile errors, so this ran against the last good build: recent .cs edits are not in it. "
                         + (f"{shown}. " if shown else "") + "Fix them, then call unity.refresh().")
            body = body[warned.end():].rstrip()
        return body, notes
    raise OpError(snippet_frames(clean_error(text)), error_name(text))


SNIPPET_FRAME = re.compile(r"at _MCPExec_[0-9a-f]+(\+\S+|\.\w+) \(\) \[0x[0-9a-f]+\] in (?:_MCPExec_[0-9a-f]+\.cs|unity\.exec):(\d+) ?")


def snippet_frames(text: str) -> str:
    return SNIPPET_FRAME.sub(lambda m: f"at unity.exec line {m.group(2)}{' (lambda)' if m.group(1).startswith('+') else ''}", text)


def player_tag(p: dict) -> dict:
    return {"player": p["index"] + 1, "role": p["role"], **({"id": p["vpId"]} if p.get("vpId") else {})}


async def exec_each(root: str, code: str, usings: str, player: str, timeout: float, code_for=None, only=None) -> list[tuple[dict, str, list[str]]]:
    from .tools_bridge import _unity_exec_each
    out = await _unity_exec_each(root, code, timeout, usings, player, code_for=code_for, only=only)
    if isinstance(out, str):
        raise OpError(clean_error(out), error_name(out))
    rows = []
    for p, text in out:
        output, notes = parse_exec_text(text)
        rows.append((p, output, notes))
    return rows


async def op_exec(args: dict, root: str) -> dict:
    code = str(args.get("code") or "")
    if not code.strip():
        raise OpError("unity.exec() needs C#: the body of a method, with Print(value) for output.", "TypeError")
    usings = args.get("usings") or ""
    if isinstance(usings, list):
        usings = ";".join(str(u) for u in usings)
    player = player_of(args, "primary")
    started = clock()
    capped = []
    rows = await exec_each(root, code, str(usings), player, wait_secs(args, 300.0, capped))
    notes = capped + [n for _, _, ns in rows for n in ns if n not in capped]
    took = clock() - started
    first = root not in EXEC_SEEN
    EXEC_SEEN.add(root)
    if first and took >= SLOW_EXEC_NOTE_SECONDS:
        notes.append(f"This unity.exec took {took:.0f} s. The first one after the editor starts or recompiles warms up "
                     "the C# compiler (up to about 25 s); the next calls are fast, so don't relaunch the editor over it.")
    if player in ("primary", "1") or (len(rows) == 1 and player not in ("all", "clones")):
        return {"value": rows[0][1], "notes": notes}
    return {"value": [{**player_tag(p), "output": out} for p, out, _ in rows], "notes": notes}


def direct_args(call_args: list) -> dict:
    types, values = [], []
    for v in call_args:
        if v is None:
            t, val = "n", ""
        elif isinstance(v, bool):
            t, val = "b", "true" if v else "false"
        elif isinstance(v, int):
            t, val = ("i" if -2**31 <= v < 2**31 else "l"), str(v)
        elif isinstance(v, float):
            if math.isnan(v) or math.isinf(v):
                raise OpError(f"can't pass {v} to a handle", "TypeError")
            t, val = "d", repr(v)
        elif isinstance(v, (list, tuple)) and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v):
            t, val = "s", ",".join(repr(float(x)) if isinstance(x, float) else str(x) for x in v)
        elif isinstance(v, (list, tuple, dict)):
            t, val = "s", json.dumps(v)
        else:
            t, val = "s", str(v)
        types.append(t)
        values.append(val)
    return {"types": types, "values": values}


def direct(op: dict):
    return lambda p: op


def js_names(text: str) -> str:
    return (text.replace("SaturaHandles.List()", "handles.list()").replace("SaturaHandles.Result(", "handles.result(")
            .replace("SaturaHandles.Stop(", "handles.stop(").replace("SaturaHandles.Call(", "handles.call("))


def parse_handle_json(text: str):
    t = js_names((text or "").strip())
    try:
        return json.loads(t)
    except ValueError:
        return {"status": "error", "error": t or "the handle call printed nothing"}


def scratchpad_hint(root: str) -> str:
    base = Path(root) / ".sspace" / "scratchpads"
    try:
        pads = sorted(str(d) for d in base.iterdir() if (d / "Assets").is_dir() and (d / "Temp" / "UnityLockfile").exists())
    except OSError:
        return ""
    if not pads:
        return ""
    return f" This looked in {root}. A scratchpad has its own handles: unity.at('{pads[0]}').handles.call(name)."


EDIT_MODE_HINT = "\nIt ran in Edit Mode because the game isn't playing. If the handle needs the running game, call unity.play() first."


def handle_failure(name: str, r: dict, who: str = "", root: str = "", editing: bool = False) -> OpError:
    err = r.get("error") or "failed"
    if root and str(err).startswith("No handle named"):
        err = f"{err}{scratchpad_hint(root)}"
    elif editing and " matches " not in str(err):
        err = f"{str(err).rstrip()}\n{EDIT_MODE_HINT.strip()}" if "\n" in str(err) else f"{err}{EDIT_MODE_HINT}"
    logs = r.get("logs") or []
    tail = ("\nLogs:\n  " + "\n  ".join(str(l) for l in logs[-20:])) if logs else ""
    return OpError(f"{who}{r.get('handle') or name}: {err}{tail}", "HandleError")


def result_code(run: int):
    return direct({"op": "result", "run": int(run)})


def poll_gap(waited: float) -> float:
    return min(max(HANDLE_POLL, waited / 8), max(HANDLE_POLL, HANDLE_POLL_MAX))


def unsettled(r: dict) -> bool:
    if r.get("loop") and (r.get("iterations") or 0) >= 1:
        return False
    return r.get("status") in ("running", "scheduled")


async def handle_poll(root: str, player: str, run: int, deadline: float, timeout: float) -> dict:
    began = time.monotonic()
    while True:
        rows = await exec_each(root, "", "", player, timeout, code_for=result_code(run))
        r = parse_handle_json(rows[0][1])
        if not unsettled(r) or time.monotonic() >= deadline:
            return r
        await asyncio.sleep(min(poll_gap(time.monotonic() - began), max(0.0, deadline - time.monotonic())))


async def handle_poll_each(root: str, player: str, results: list, deadline: float) -> list:
    began = time.monotonic()
    out = {p["dir"]: (p, r) for p, r in results}
    while True:
        waiting = {d: r["run"] for d, (p, r) in out.items() if r.get("run") and unsettled(r)}
        if not waiting or time.monotonic() >= deadline:
            return [out[p["dir"]] for p, _ in results]
        rows = await exec_each(root, "", "", player, 300.0,
                               code_for=lambda p: result_code(waiting[p["dir"]])(p), only=set(waiting))
        for p, text, _ in rows:
            out[p["dir"]] = (p, parse_handle_json(text))
        if any(unsettled(r) for _, r in out.values()):
            await asyncio.sleep(min(poll_gap(time.monotonic() - began), max(0.0, deadline - time.monotonic())))


async def stop_on_cancel(root: str, name: str, runs: list[tuple[str, int]]) -> None:
    for player, run in runs:
        try:
            await asyncio.wait_for(exec_each(root, "", "", player, STOP_ON_CANCEL, code_for=direct({"op": "stop", "run": int(run)})), STOP_ON_CANCEL)
        except Exception:
            continue
        notes = cleanup_notes.get()
        if notes is not None:
            who = f" on player {player}" if player not in ("primary", "1") else ""
            notes.append(f"handles.call {name} (run {run}){who} was still running when the script stopped, so it was stopped.")


def handle_timeout(name: str, r: dict, timeout: float, who: str = "", player: str = "") -> OpError:
    run = r.get("run")
    pl = f"player: '{player}'" if player and player not in ("primary", "1") else ""
    on = f", {{{pl}}}" if pl else ""
    more = ", ".join(x for x in ("wait: true", pl) if x)
    return OpError(f"{who}{r.get('handle') or name} (run {run}) is still {r.get('status') or 'running'} after {timeout:g} s; "
                   f"it keeps running in Unity. Read it later with handles.result({run}{on}), wait more with "
                   f"handles.result({run}, {{{more}}}), stop it with handles.stop({run}{on}), "
                   "or call with {wait: false} to get the run id at once.", "HandleTimeout")


async def op_handle_call(args: dict, root: str) -> dict:
    name = str(args.get("name") or "").strip()
    if not name:
        raise OpError("handles.call() needs the handle's name, like handles.call('CastRod', 0.8). See handles.list().", "TypeError")
    call_args = args.get("args") or []
    if not isinstance(call_args, list):
        call_args = [call_args]
    typed = direct_args(call_args)
    player = player_of(args, "primary")
    wait = args.get("wait") is not False
    timeout = num(args, "timeout", DEFAULT_HANDLE_WAIT)
    together = player in ("all", "clones") or args.get("at") is not None
    if not together:
        rows = await exec_each(root, "", "", player, 300.0,
                               code_for=direct({"op": "call", "name": name, **typed}))
        r = parse_handle_json(rows[0][1])
        notes = rows[0][2]
        if r.get("status") == "error" and r.get("needsPlay"):
            await op_open_scene({"play": True}, root)
            notes = list(notes) + [f"{r.get('handle') or name} is a scenario, so Play Mode was started first."]
            rows = await exec_each(root, "", "", player, 300.0,
                                   code_for=direct({"op": "call", "name": name, **typed}))
            r = parse_handle_json(rows[0][1])
            notes += [n for n in rows[0][2] if n not in notes]
        if r.get("status") == "error" and not r.get("scenario"):
            raise handle_failure(name, r, root=root, editing=not rows[0][0].get("isPlaying"))
        if r.get("status") == "running" and wait and r.get("run"):
            run = r["run"]
            try:
                r = await handle_poll(root, player, run, time.monotonic() + timeout, 300.0)
            except asyncio.CancelledError:
                await stop_on_cancel(root, name, [(player, run)])
                raise
            if r.get("status") == "error" and not r.get("scenario"):
                raise handle_failure(name, r)
            if unsettled(r):
                raise handle_timeout(name, r, timeout, player=player)
            if r.get("loop") and r.get("status") == "running":
                notes = list(notes) + [f"{r.get('handle') or name} loops: this is iteration {r.get('iterations')}, and it keeps running. "
                                       f"Read later iterations with handles.result({run}) and end it with handles.stop({run})."]
        return {"value": r, "notes": notes} if notes else {"value": r}
    players = select_targets(discover_players(root), player)
    if not players:
        raise OpError(f"No live player matches player '{player}'.")
    playing = all(p.get("isPlaying") for p in players)
    fresh = playing and time.monotonic() - PLAYED_AT.get(root, -1e9) < FRESH_PLAY_SECONDS
    delay = num(args, "at", (2.5 if fresh else 1.0) + 0.1 * len(players) if playing else 1.5 + 0.1 * len(players))
    start = int(time.time() * 1000) + int(delay * 1000)
    rows = await exec_each(root, "", "", player, 300.0,
                           code_for=direct({"op": "startAt", "unixMs": start, "name": name, **typed}))
    results = []
    notes = []
    for p, out, ns in rows:
        notes += [n for n in ns if n not in notes]
        r = parse_handle_json(out)
        if r.get("status") == "error":
            raise handle_failure(name, r, f"Player {p['index'] + 1}: ", editing=not p.get("isPlaying"))
        results.append((p, r))
    if wait:
        deadline = time.monotonic() + delay + timeout
        try:
            await asyncio.sleep(min(delay, max(0.0, deadline - time.monotonic())))
            results = await handle_poll_each(root, player, results, deadline)
        except asyncio.CancelledError:
            await stop_on_cancel(root, name, [(str(p["index"] + 1), r["run"]) for p, r in results if r.get("run")])
            raise
    for p, r in results:
        if r.get("status") == "error":
            raise handle_failure(name, r, f"Player {p['index'] + 1}: ")
        if wait and unsettled(r):
            raise handle_timeout(name, r, timeout, f"Player {p['index'] + 1}: ", str(p["index"] + 1))
    lates = [r.get("lateMs") if isinstance(r.get("lateMs"), (int, float)) else 0 for _, r in results]
    if len(lates) > 1 and min(lates) > 100 and max(lates) - min(lates) <= 100:
        notes.append(f"All {len(lates)} players started within {int(max(lates) - min(lates))} ms of each other, but "
                     f"{int(max(lates))} ms after the planned moment because the editors were slow to answer. "
                     f"Pass a larger at, like {{ at: {math.ceil(delay + max(lates) / 1000 + 0.5)} }}, to start on time.")
    else:
        for (p, _), late in zip(results, lates):
            if late > 100:
                notes.append(f"Player {p['index'] + 1} started {int(late)} ms after the shared moment. "
                             f"For a closer start pass a larger at, like {{ at: {math.ceil(delay + late / 1000 + 0.5)} }}.")
    return {"value": [{**player_tag(p), **r} for p, r in results], "notes": notes}


async def op_handle_list(args: dict, root: str) -> dict:
    flt = str(args.get("filter") or "")
    rows = await exec_each(root, "", "", player_of(args, "primary"), 120.0,
                           code_for=direct({"op": "list", "filter": flt}))
    return {"value": rows[0][1].replace("SaturaHandles.Call(path, args...)", "handles.call(path, ...args)")}


async def op_handle_run(args: dict, root: str, method: str) -> dict:
    run = int(num(args, "run", 0) or 0)
    rows = await exec_each(root, "", "", player_of(args, "primary"), 120.0,
                           code_for=direct({"op": method.lower(), "run": run}))
    r = parse_handle_json(rows[0][1])
    if method == "Result" and args.get("wait") and unsettled(r) and r.get("run"):
        wait = num(args, "timeout", DEFAULT_HANDLE_WAIT)
        who = player_of(args, "primary")
        r = await handle_poll(root, who, r["run"], time.monotonic() + wait, 300.0)
        if unsettled(r):
            raise handle_timeout("", r, wait, player=who)
    if method == "Result" and args.get("wait") and r.get("status") == "error" and r.get("handle") and not r.get("scenario"):
        raise handle_failure(r["handle"], r)
    if r.get("status") == "error" and not r.get("handle"):
        raise OpError(r.get("error") or "no such run", "HandleError")
    return {"value": r}


def active_scene(root: str) -> str:
    health = instances.editor_health(root)
    if health.get("state") == "DOWN":
        msg = STOPPED_NOTE if orchestrator_stopped(root) else no_editor_message(root)
        raise OpError(msg, error_name(msg))
    scenes = health.get("scenes") or []
    active = next((s for s in scenes if s.get("active")), None) or (scenes[0] if scenes else None)
    path = (active or {}).get("path") or ""
    if not path:
        raise OpError("No scene is open to play. Pass one: unity.play('Assets/Scenes/Main.unity').", "TypeError")
    return path


PLAYED_AT: dict[str, float] = {}
FRESH_PLAY_SECONDS = 20.0


async def op_open_scene(args: dict, root: str) -> dict:
    from .tools_bridge import unity_open_scene
    play = bool(args.get("play"))
    scene = str(args.get("scene") or "").strip() or (active_scene(root) if play else "")
    capped = []
    if not scene:
        raise OpError("unity.openScene() needs a scene path, like 'Assets/Scenes/Main.unity'.", "TypeError")
    res = await unity_open_scene(
        scene_path=scene, enter_play_mode=play, hot_reload=bool(args.get("hotReload")),
        refresh=args.get("refresh") is not False, timeout_seconds=wait_secs(args, 60, capped),
        unsaved=str(args.get("unsaved") or ""), project_root=root,
    )
    text, _ = split_result(res)
    notes = capped + [l.strip() for l in text.splitlines() if l.strip().startswith("WARNING")]
    if failed(text) or ("ERROR" in text and " across " in text.splitlines()[0]):
        raise OpError(clean_error(text), error_name(text))
    value = "\n".join(l for l in text.splitlines() if not l.strip().startswith("WARNING")).strip()
    if play:
        PLAYED_AT[root] = time.monotonic()
    return {"value": value or text.strip(), "notes": notes}


SHOT_ANGLES = {
    "auto": (35.0, 20.0), "three-quarter": (35.0, 20.0), "front": (0.0, 10.0), "back": (180.0, 10.0),
    "left": (-90.0, 10.0), "right": (90.0, 10.0), "top": (0.0, 89.0),
}


def shot_angle(i: int, angle) -> tuple[float, float]:
    if angle is None:
        return SHOT_ANGLES["auto"]
    if isinstance(angle, str) and angle in SHOT_ANGLES:
        return SHOT_ANGLES[angle]
    if isinstance(angle, dict) and set(angle) <= {"yaw", "pitch"}:
        try:
            return float(angle.get("yaw", 0)), float(angle.get("pitch", 0))
        except (TypeError, ValueError):
            pass
    names = "', '".join(SHOT_ANGLES)
    raise OpError(f"pose {i + 1}: angle is '{names}' or {{ yaw, pitch }} in degrees, got {angle!r}.", "TypeError")


def poses(raw) -> list[dict]:
    items = raw if isinstance(raw, list) else [raw]
    out = []
    for i, p in enumerate(items):
        if not isinstance(p, dict):
            raise OpError("unity.screenshot() takes { camera: [x, y, z], lookAt: [x, y, z] }, { frame: 'Level/Player' } or a list of them.", "TypeError")
        known = {"camera", "camera_pos", "position", "lookAt", "look_at", "at", "frame", "angle", "distance", "isolate", "hide"}
        extra = sorted(set(p) - known)
        if extra:
            raise OpError(f"pose {i + 1} has unknown keys {', '.join(extra)}. A pose is {{ camera, lookAt }} or {{ frame, angle, distance }}, plus isolate and hide.", "TypeError")
        shot = {}
        isolate = p.get("isolate")
        if isolate is True:
            if not isinstance(p.get("frame"), str):
                raise OpError(f"pose {i + 1}: isolate: true draws only the framed object, so it needs frame. Pass paths instead, like isolate: ['Level/Player'].", "TypeError")
            isolate = p["frame"]
        if isolate is not None and isolate is not False:
            shot["isolate"] = isolate
        if p.get("hide") is not None:
            shot["hide"] = p["hide"]
        if p.get("frame") is not None:
            yaw, pitch = shot_angle(i, p.get("angle"))
            dist = p.get("distance", 0)
            out.append({"frame": p["frame"], "yaw": yaw, "pitch": pitch, "distance": dist, **shot})
            continue
        if p.get("angle") is not None or p.get("distance") is not None:
            raise OpError(f"pose {i + 1}: angle and distance go with frame, like {{ frame: 'Level/Player', angle: 'front' }}.", "TypeError")
        cam = p.get("camera", p.get("camera_pos", p.get("position")))
        at = p.get("lookAt", p.get("look_at", p.get("at")))
        if cam is None or at is None:
            raise OpError(f"pose {i + 1} needs camera and lookAt, like {{ camera: [0, 5, -10], lookAt: [0, 0, 0] }}, or frame, like {{ frame: 'Level/Player' }}.", "TypeError")
        out.append({"camera_pos": cam, "look_at": at, **shot})
    return out


async def op_screenshot(args: dict, root: str) -> dict:
    from .tools_bridge import unity_screenshot
    save = args.get("save")
    path = save if isinstance(save, str) else ""
    notes = []
    res = await unity_screenshot(points=poses(args.get("poses")), save=bool(save), path=path,
                                 timeout_seconds=wait_secs(args, 60, notes), project_root=root)
    return text_result(res, notes)


async def op_logs(args: dict, root: str) -> dict:
    from .tools_logs import unity_logs
    grep = args.get("grep") or ""
    if isinstance(grep, dict):
        grep = ("(?i)" if "i" in str(grep.get("flags") or "") else "") + str(grep.get("source") or "")
    elif grep and not str(grep).startswith("(?"):
        grep = "(?i)" + str(grep)
    lines = whole(args, "lines", 400)
    source = str(args.get("source") or ("tags" if args.get("tag") else "auto"))
    severity = {"warning": "warn", "errors": "error", "info": "log"}.get(str(args.get("severity") or "all"), str(args.get("severity") or "all"))
    if source not in ("auto", "console", "compile", "editor", "tags"):
        raise OpError(f"unity.logs(): source is auto, console, compile, editor or tags, got {source!r}", "TypeError")
    if severity not in ("all", "log", "warn", "error"):
        raise OpError(f"unity.logs(): severity is all, log, warn or error, got {severity!r}", "TypeError")
    res = await unity_logs(
        source=source, severity=severity, grep=str(grep),
        lines=lines, player=player_of(args, "all"),
        collapse=args.get("collapse") is not False, tag=str(args.get("tag") or ""), project_root=root,
    )
    text, _ = split_result(res)
    if text.startswith("ERROR:"):
        raise OpError(clean_error(text))
    return {"value": text.replace("\ufeff", "").strip()}


def camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(r.title() for r in rest)


async def call(fn, root: str, notes: list[str] | None = None, **kw) -> dict:
    allowed = [n for n in inspect.signature(fn).parameters if n not in ("project_root", "ctx")]
    unknown = [k for k in kw if k not in allowed]
    if unknown:
        raise OpError(f"Unknown option {', '.join(camel(k) for k in unknown)}. Options: {', '.join(camel(a) for a in allowed)}.", "TypeError")
    return text_result(await fn(project_root=root, **kw), notes)


def snake(args: dict, renames: dict | None = None, drop: tuple = ()) -> dict:
    out = {}
    for k, v in (args or {}).items():
        if k in drop or v is None:
            continue
        key = (renames or {}).get(k) or re.sub(r"([A-Z])", lambda m: "_" + m.group(1).lower(), k)
        out[key] = v
    return out


FPS_WAIT = 4.0


async def op_fps(args: dict, root: str) -> dict:
    from .multiplayer import orchestrator_present, request_player_command, resolve_player_dir
    real, player_dir = resolve_player_dir(root)
    if not orchestrator_present(str(real)):
        raise OpError("Frame-rate caps work on editors that Satura Space runs. Open the project in Satura Space and retry.")
    extra: dict = {"target": str(args.get("player") or player_dir or "primary")}
    setting = "cap" in args
    if setting:
        extra["fpsCap"] = args["cap"]
    r = await request_player_command(str(real), "fps_cap", extra=extra, timeout=15.0)
    if r.get("error") == "no_orchestrator":
        raise OpError("Frame-rate caps work on editors that Satura Space runs. Open the project in Satura Space and retry.")
    if r.get("error") == "timeout":
        raise OpError("Satura Space didn't answer within 15 s. Check unity.status().")
    if not r.get("ok"):
        raise OpError(str(r.get("error") or "unknown error"))
    entries = [e for e in r.get("fps") or [] if isinstance(e, dict)]
    until = clock() + (FPS_WAIT if setting else 0)
    while True:
        states = [instances._read_status(Path(str(e.get("dir") or ""))) or {} for e in entries]
        pending = [s for e, s in zip(entries, states) if s.get("isPlaying") and int(s.get("fpsCap") or 0) != int(e.get("cap") or 0)]
        if not pending or clock() >= until:
            break
        await asyncio.sleep(0.25)
    rows = []
    for e, st in zip(entries, states):
        row = {"player": e.get("player"), "cap": int(e.get("cap") or 0) or None, "playing": bool(st.get("isPlaying"))}
        if row["playing"]:
            row["targetFrameRate"] = st.get("targetFrameRate")
            row["vSyncCount"] = st.get("vSyncCount")
            row["fps"] = (st.get("isStreaming") and st.get("streamActualFps")) or st.get("actualFps") or None
            row["setBy"] = st.get("fpsSource") or None
        rows.append(row)
    return {"value": rows[0] if len(rows) == 1 else rows}


async def op_stream_res(args: dict, root: str) -> dict:
    from .multiplayer import orchestrator_present, request_player_command, resolve_player_dir
    real, player_dir = resolve_player_dir(root)
    absent = "Stream sizes work on editors that Satura Space runs. Open the project in Satura Space and retry."
    if not orchestrator_present(str(real)):
        raise OpError(absent)
    extra: dict = {"target": str(args.get("player") or player_dir or "primary")}
    if args.get("size") is not None:
        extra["streamRes"] = str(args["size"])
    r = await request_player_command(str(real), "stream_res", extra=extra, timeout=15.0)
    if r.get("error") == "no_orchestrator":
        raise OpError(absent)
    if r.get("error") == "timeout":
        raise OpError("Satura Space didn't answer within 15 s. Check unity.status().")
    if not r.get("ok"):
        raise OpError(str(r.get("error") or "unknown error"), "TypeError" if "WIDTHxHEIGHT" in str(r.get("error") or "") else "UnityError")
    rows = [{k: e[k] for k in ("player", "size", "recording") if k in e} for e in r.get("streams") or [] if isinstance(e, dict)]
    return {"value": rows[0] if len(rows) == 1 else rows}


async def dispatch(fn: str, args: dict, root: str) -> dict:
    args = args if isinstance(args, dict) else {}
    if args.get("player") is not None:
        args["player"] = str(args["player"])
    root = resolve_root(str(args.pop("project", "") or root or ""))
    if fn == "unity.exec":
        return await op_exec(args, root)
    if fn == "unity.openScene":
        return await op_open_scene(args, root)
    if fn == "unity.screenshot":
        return await op_screenshot(args, root)
    if fn == "unity.logs":
        return await op_logs(args, root)
    if fn == "unity.players":
        return {"value": [{**player_tag(p), "playing": bool(p.get("isPlaying")), "dir": p["dir"]} for p in discover_players(root)]}
    if fn == "handles.call":
        return await op_handle_call(args, root)
    if fn == "handles.list":
        return await op_handle_list(args, root)
    if fn == "handles.result":
        return await op_handle_run(args, root, "Result")
    if fn == "handles.stop":
        return await op_handle_run(args, root, "Stop")
    if fn == "unity.fps":
        return await op_fps(args, root)
    if fn == "unity.resolution":
        return await op_stream_res(args, root)
    if fn == "unity.status":
        from .tools_instances import unity_editor_status
        return await call(unity_editor_status, root, lifecycle=args.get("lifecycle") is not False)
    if fn == "unity.stop":
        from .tools_bridge import unity_stop_play
        notes = []
        limit = wait_secs(args, 30, notes)
        until = time.monotonic() + min(limit, 15)
        while True:
            try:
                return await call(unity_stop_play, root, notes, timeout_seconds=limit)
            except OpError as e:
                if "still loading" not in str(e) or time.monotonic() >= until:
                    raise
                await asyncio.sleep(0.5)
    if fn == "unity.refresh":
        from .tools_bridge import unity_refresh
        notes = []
        out = await call(unity_refresh, root, notes, timeout_seconds=wait_secs(args, 300, notes))
        from .input_gate import legacy_input_note
        from .satura_guard import guard_note
        for scan in (legacy_input_note, guard_note):
            note = await asyncio.to_thread(scan, root)
            if note:
                out["notes"] = [*(out.get("notes") or []), note]
        return out
    if fn == "unity.relaunch":
        from .tools_players import unity_relaunch
        notes = []
        asked = secs(args, "timeout", 180)
        if asked > RELAUNCH_MAX_WAIT:
            notes.append(f"timeout is capped at {RELAUNCH_MAX_WAIT} s.")
        return await call(unity_relaunch, root, notes, timeout_seconds=min(asked, RELAUNCH_MAX_WAIT))
    if fn == "unity.shutdown":
        from .tools_instances import unity_shutdown
        return await call(unity_shutdown, root, force=bool(args.get("force")), timeout_seconds=secs(args, "timeout", 60))
    if fn == "unity.dialogs":
        from .tools_dialogs import unity_resolve_dialog
        return await call(unity_resolve_dialog, root, action=str(args.get("action") or ""), dialog_id=str(args.get("id") or ""),
                          button=str(args.get("button") or ""), timeout_seconds=secs(args, "timeout", 15))
    if fn == "unity.source":
        from .tools_source import unity_source
        return await call(unity_source, root, **snake(args, {"includePrivate": "include_private"}))
    if fn == "unity.docs":
        from .tools_source import unity_docs
        return await call(unity_docs, root, api=str(args.get("api") or ""), version=str(args.get("version") or ""))
    if fn == "unity.trace":
        from .tools_trace import unity_trace
        for key in ("seconds", "timeout"):
            args[key] = num(args, key, None)
        for key in ("maxEvents", "maxLines"):
            args[key] = whole(args, key, None)
        kw = snake(args, {"ancestors": "include_ancestors", "timeout": "timeout_seconds"})
        notes = []
        if kw.get("command") == "start" and not any(p.get("isPlaying") for p in discover_players(root)):
            notes.append("Not in Play Mode: entering Play or recompiling wipes this trace. Call unity.play() first, then start it.")
        return await call(unity_trace, root, notes, **kw)
    if fn == "video":
        if str(args.get("player") or "").strip().lower() in ("all", "clones"):
            raise OpError(f"video films one player's panel, so player '{args['player']}' doesn't work: pass a number, like {{ player: 2 }}, and record each player in turn.", "TypeError")
        if args.get("path") is not None and not isinstance(args["path"], str):
            raise OpError(f"path must be a string, got {args['path']!r}", "TypeError")
        from .tools_video import unity_video
        return await call(unity_video, root, **snake(args))
    if fn == "tuner.filter":
        from .tools_tuner import unity_tuner
        pad = str(args.pop("scratchpad", "") or "")
        if pad:
            root = str(Path(root) / ".sspace" / "scratchpads" / pad)
        return await call(unity_tuner, root, **snake(args, {"open": "open_panel"}))
    if fn == "scratchpad":
        from .tools_scratchpads import unity_scratchpad
        return await call(unity_scratchpad, root, **snake(args, {"wait": "wait_seconds", "id": "scratchpad"}))
    if fn == "scratchpad.copy":
        from .tools_scratchpads import unity_scratchpad_copy
        return await call(unity_scratchpad_copy, root, **snake(args, {"id": "scratchpad"}))
    if fn == "env":
        from .tools_env import satura_env_files
        return await call(satura_env_files, root, command=str(args.get("command") or ""), paths=args.get("paths"))
    raise OpError(f"Unknown call {fn}.", "TypeError")
