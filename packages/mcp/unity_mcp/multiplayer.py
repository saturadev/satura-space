"""Multiplayer support: discover the live editors for a project, target them, and route commands to them
through the orchestrator.

The Satura Space orchestrator launches local multiplayer as a batchmode PRIMARY editor at the real
project root plus N headless CLONE editors under ``<project>/Library/VP/mppm<id>/``. Every editor runs
MCPTestBridge and writes its OWN ``.sspace/.mcp_status.json``, so the live set is discoverable purely
from the filesystem — no orchestrator IPC needed for discovery.

The orchestrator owns clone lifecycle (the MPPM clone recipe is fragile to reimplement and buggy
standalone). Routed actions (scene, stop, refresh, relaunch) go to it as a request in
``<project>/.sspace/.mcp_players_command.json``, and the orchestrator (when it has that project's tab
open) acts and writes the result back. The MCP itself never launches a clone; agents add or remove
players through ``unity.addPlayer()``, or a scratchpad's own ``addPlayer()``.
"""
import asyncio
import json
import time
import uuid
from pathlib import Path

from . import instances
from . import modal_status
from . import proc_identity
from .control_protocol import NdjsonParser, encode_message
from .sspace import ensure_sspace_for

PLAYERS_COMMAND_FILE = ".mcp_players_command.json"
PLAYERS_RESULT_FILE = ".mcp_players_result.json"
ORCHESTRATOR_FILE = ".mcp_orchestrator.json"

def resolve_player_dir(player_root) -> tuple[Path, str | None]:
    """Map any player dir to ``(real project root, that player's target id)``.

    A clone editor lives at ``<project>/Library/VP/<vpId>`` and has its own ``.sspace`` channel, but the
    orchestrator marker exists ONLY at the real project root. Callers that resolve orchestrator ownership
    against a raw clone dir therefore conclude "standalone" and start writing that clone's ``commands.json``
    themselves — a SECOND writer on a single-writer channel, whose independently-allocated ids collide with
    the orchestrator's and silently strand commands below the acked cursor. Resolve through this first.

    Returns ``(root, None)`` for a primary/standalone project (the dir IS the project root)."""
    p = Path(player_root).resolve()
    if p.parent.name == "VP" and p.parent.parent.name == "Library":
        return p.parent.parent.parent, p.name
    return p, None


def orchestrator_present(project_root: str = "") -> bool:
    """True if the Satura Space orchestrator is managing this project (its command watcher is live).

    When true, editor commands (open scene / play / stop / refresh) are routed THROUGH the orchestrator so
    its UI reflects them; when false (a standalone GUI editor or the MCP's own headless build server) the
    MCP drives the editor directly. The marker carries the orchestrator's pid — checked alive.
    """
    root = instances._root(project_root)
    marker = root / ".sspace" / ORCHESTRATOR_FILE
    data = instances._read_json(marker)
    if not isinstance(data, dict):
        return False
    pid = data.get("pid")
    return bool(pid and instances._alive(pid)) and proc_identity.app_marker_trusted(pid, marker)

async def orchestrator_drives(project_root: str = "") -> bool:
    """True when the orchestrator both manages this project AND owns at least one live editor for it —
    the condition for routing scene/stop/refresh/arm commands through it. A present orchestrator with NO
    live instance (project tab or panel closed, or its editor exited) is not driving anything: commands
    routed to it just fail with "No players running", while a heartbeat-live editor launched outside it
    (a headless build server, a user's GUI editor) can be driven directly. An unreachable-but-marked
    orchestrator counts as not driving; any other status failure keeps routing (conservative)."""
    if not orchestrator_present(project_root):
        return False
    st = await request_player_command(project_root, "status", timeout=10.0)
    if st.get("error") == "no_orchestrator":
        return False
    if not st.get("ok"):
        return True
    return bool(st.get("players"))

ADD_PANEL_MESSAGE = (
    "No Unity editor is running for this project. unity.relaunch() starts one and waits until it is "
    "ready; or ask the user to open the project's Unity Player panel in Satura Space."
)


def scratchpad_id(project_root: str) -> str:
    p = Path(project_root or "")
    if p.parent.name == "scratchpads" and p.parent.parent.name == ".sspace":
        return p.name
    return ""


def orchestrator_hub_blocked(project_root: str = "") -> str | None:
    if not orchestrator_present(project_root):
        return None
    data = instances._read_json(instances._root(project_root) / ".sspace" / ORCHESTRATOR_FILE)
    msg = data.get("hubBlocked") if isinstance(data, dict) else None
    return msg if isinstance(msg, str) and msg else None

def no_editor_message(project_root: str) -> str:
    hub = orchestrator_hub_blocked(project_root)
    if hub:
        return hub
    from .input_gate import refusal
    refused = refusal(project_root)
    if refused:
        return refused
    pad = scratchpad_id(project_root)
    if pad:
        return f"No Unity editor is running for this scratchpad. scratchpad.start('{pad}') starts it."
    return ADD_PANEL_MESSAGE


def require_player_panel(project_root: str = "") -> str | None:
    """Guard for Unity-editor tools: block only when there is NOTHING to drive — no orchestrator managing
    the project AND no live editor owning it. In standalone-editor mode (the MCP is hard-locked to one
    project), when the orchestrator is present, or when any editor (GUI or headless build-server) is
    already up, it never blocks — those tools attach to and drive that editor directly."""
    from .helpers import locked_root

    if orchestrator_stopped(project_root) and not discover_players(project_root):
        return f"ERROR: {STOPPED_NOTE}"
    hub = orchestrator_hub_blocked(project_root)
    if hub and not discover_players(project_root):
        return f"ERROR: {hub}"
    if locked_root() is not None:
        return None
    if orchestrator_present(project_root):
        return None
    if discover_players(project_root):
        return None
    return no_editor_message(project_root)

def _entry(index: int, role: str, vp_id, health: dict) -> dict:
    return {
        "index": index,
        "role": role,
        "vpId": vp_id,
        "dir": health.get("root"),
        "pid": health.get("pid"),
        "state": health.get("state"),
        "isPlaying": health.get("isPlaying"),
        "isPaused": health.get("isPaused"),
        "isCompiling": health.get("isCompiling"),
        "isBatchMode": health.get("isBatchMode"),
        "activeScene": health.get("activeScene"),
        "activeSceneName": health.get("activeSceneName"),
        "scenesDirty": health.get("scenesDirty"),
        "scenes": health.get("scenes") or [],
    }

def _scene_id(s: dict) -> str:
    return s.get("path") or s.get("name") or "<untitled>"

def scene_lines(health: dict, indent: str = "  ") -> list[str]:
    """Per-open-scene lines: path, active/additive, root count, unsaved/unloaded flags."""
    scenes = health.get("scenes") or []
    if not scenes:
        if health.get("activeScene") is None:
            return [f"{indent}Scene: not reported (editor predates scene status — relaunch it to pick it up)"]
        return [f"{indent}Scene: none open"]
    out = []
    for s in scenes:
        flags = ["active" if s.get("active") else "additive", f"{s.get('rootCount', 0)} roots"]
        if not s.get("loaded"):
            flags.append("NOT LOADED")
        if s.get("dirty"):
            flags.append("UNSAVED")
        out.append(f"{indent}Scene: {_scene_id(s)}  ({', '.join(flags)})")
    return out

def scene_brief(health: dict) -> str:
    """Compact 'what's open' for a player line: active scene name + unsaved marker."""
    scenes = health.get("scenes") or []
    active = next((s for s in scenes if s.get("active")), None)
    if active is None:
        if health.get("activeScene") is None:
            return "scene=?"
        return "scene=none"
    label = active.get("name") or Path(_scene_id(active)).stem or "<untitled>"
    star = "*" if active.get("dirty") else ""
    others = [s for s in scenes if not s.get("active")]
    extra = ""
    if others:
        dirty_others = sum(1 for s in others if s.get("dirty"))
        unsaved = f", {dirty_others} UNSAVED" if dirty_others else ""
        extra = f" (+{len(others)} additive{unsaved})"
    return f"scene={label}{star}{extra}"

def discover_players(project_root: str = "") -> list[dict]:
    """Return the live editors for this project: the primary (index 0) followed by any orchestrator
    clones found under ``Library/VP/``, in stable order. Down/stale editors are omitted. Never launches.
    """
    root = instances._root(project_root)
    players: list[dict] = []

    primary = instances.editor_health(str(root))
    if primary.get("state") != "DOWN":
        players.append(_entry(0, "primary", None, primary))

    vp = root / "Library" / "VP"
    if vp.is_dir():
        clones = []
        for d in vp.iterdir():
            if not d.is_dir():
                continue
            health = instances.editor_health(str(d))
            if health.get("state") == "DOWN":
                continue
            clones.append((_player_index(d), d.name, health))
        for _, name, health in sorted(clones, key=lambda c: (c[0], c[1])):
            players.append(_entry(len(players), "clone", name, health))

    return players


def _player_index(clone_dir: Path) -> int:
    data = instances._read_json(clone_dir / ".sspace" / "world.json")
    try:
        n = int(data["world"]["instances"][clone_dir.name]["playerIndex"])
    except (TypeError, ValueError, KeyError):
        n = 0
    return n if n > 0 else 1 << 30

def player_label(p: dict) -> str:
    who = p["role"] + (f" {p['vpId']}" if p.get("vpId") else "")
    return f"Player {p['index'] + 1} [{who}] pid={p.get('pid') or '—'}"

def players_summary(project_root: str = "") -> str:
    """A one-or-many-line summary of the live player set, appended to status/refresh responses."""
    players = discover_players(project_root)
    dialog_note = modal_status.players_dialog_note(project_root)
    if not players:
        return "Instances: none running." + (f"\n{dialog_note}" if dialog_note else "")
    lines = [f"Instances: {len(players)} player(s)" + ("  (multiplayer)" if len(players) > 1 else "  (single editor)")]
    for p in players:
        if p.get("isCompiling"):
            mode = "compiling"
        elif p.get("isPlaying"):
            mode = "PAUSED" if p.get("isPaused") else "playing"
        else:
            mode = "edit"
        blocked = (
            " [BLOCKED BY DIALOG]"
            if p.get("dir") and modal_status.blocking_dialogs(Path(p["dir"]))
            else ""
        )
        lines.append(
            f"  Player {p['index'] + 1} [{p['role']}] {p['state']}{blocked} ({mode}) "
            f"pid={p['pid'] or '—'} vpId={p['vpId'] or '—'} {scene_brief(p)}\n    dir: {p['dir']}"
        )
    if dialog_note:
        lines.append(dialog_note)
    return "\n".join(lines)

def select_targets(players: list[dict], target: str) -> list[dict]:
    """Pick which players a scene/play op hits. target: 'all' (default), 'primary', 'clones', a vpId,
    a 1-based player number, or a dir path."""
    t = (target or "all").strip()
    if t in ("", "all"):
        return players
    if t == "primary":
        return [p for p in players if p["role"] == "primary"]
    if t == "clones":
        return [p for p in players if p["role"] == "clone"]
    byvp = [p for p in players if p["vpId"] == t]
    if byvp:
        return byvp
    bydir = [p for p in players if p["dir"] == t]
    if bydir:
        return bydir
    if t.isdigit():
        n = int(t)
        return [p for p in players if p["index"] + 1 == n]
    return []

def format_player_line(player: dict, role: str, out: dict) -> str:
    tag = f"Player {player['index'] + 1} [{player.get('vpId') or role or player.get('role')}]"
    if out.get("dialog_blocked"):
        first = out["dialog_blocked"].splitlines()[0]
        return f"{tag}  BLOCKED BY DIALOG: {first} (see unity.answer())"
    if out.get("scene_error") is not None:
        return f"{tag}  SCENE ERROR: {out['scene_error']}"
    if out.get("scene_timeout"):
        return f"{tag}  TIMEOUT opening scene"
    return f"{tag}  {out.get('scene_msg') or 'scene opened'}"

def _command_files(root: Path):
    ss = root / ".sspace"
    return ss / PLAYERS_COMMAND_FILE, ss / PLAYERS_RESULT_FILE

def orchestrator_stopped(project_root: str = "") -> bool:
    if not orchestrator_present(project_root):
        return False
    root = instances._root(project_root)
    try:
        data = json.loads((root / ".sspace" / ORCHESTRATOR_FILE).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return isinstance(data, dict) and data.get("stopped") is True

STOPPED_NOTE = (
    "Unity is stopped in Satura Space (Stop in the Player menu, or unity.shutdown()). It stays stopped, "
    "across app restarts too, until unity.relaunch() or the panel's Relaunch starts it again. If you did "
    "not stop it yourself, the user did: ask before starting it."
)

def _orchestrator_control(root: Path) -> tuple[int, str]:
    """The orchestrator control-socket port and token from .mcp_orchestrator.json (port 0 = none/old orchestrator)."""
    try:
        data = json.loads((root / ".sspace" / ORCHESTRATOR_FILE).read_text(encoding="utf-8"))
        return int(data.get("controlPort") or 0), str(data.get("controlToken") or "")
    except (OSError, json.JSONDecodeError, ValueError, TypeError, AttributeError):
        return 0, ""

_RESENDABLE_ACTIONS = frozenset({"status", "scene_wait"})


def unknown_outcome(action: str, why: str) -> dict:
    return {
        "ok": False,
        "error": "timeout",
        "unknownOutcome": True,
        "detail": (
            f"UNKNOWN OUTCOME: Satura Space received the '{action}' request but {why}, so it may or may not "
            "have run. Check the state it changes (unity.status(), video.status(), unity.logs()) before you "
            "call it again; don't just retry."
        ),
    }


async def _request_via_socket(root: Path, payload: dict, timeout: float) -> dict | None:
    """Send a routed player command over the orchestrator control socket and await its result.

    Returns the result dict, or None to fall back to the file channel (no port advertised, an old
    orchestrator, or the connection failing before the command was fully sent). Once the command is
    sent, a missing reply (timeout or closed connection) returns ``unknown_outcome`` instead: the
    orchestrator may already be acting on it, so resending it could run it twice.
    """
    port, token = _orchestrator_control(root)
    if port <= 0:
        return None
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), timeout=5.0)
    except (OSError, asyncio.TimeoutError):
        return None
    action = str(payload.get("action") or "")
    try:
        try:
            writer.write(encode_message({"type": "hello", "token": token}))
            writer.write(encode_message({"type": "command", "id": 1, "cmd": "players", "args": payload}))
            await asyncio.wait_for(writer.drain(), timeout=5.0)
        except (OSError, asyncio.TimeoutError):
            return None
        parser = NdjsonParser()
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return unknown_outcome(action, f"didn't answer within {int(timeout)} s")
            try:
                chunk = await asyncio.wait_for(reader.read(4096), timeout=remaining)
            except asyncio.TimeoutError:
                return unknown_outcome(action, f"didn't answer within {int(timeout)} s")
            except OSError:
                chunk = b""
            if not chunk:
                return unknown_outcome(action, "closed the connection before answering")
            for msg in parser.push(chunk):
                if msg.get("type") == "result":
                    return msg
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except OSError:
            pass

async def request_player_command(
    project_root: str,
    action: str,
    *,
    extra: dict | None = None,
    timeout: float = 25.0,
    poll: float = 0.3,
) -> dict:
    """Write a command for the orchestrator and await its result by requestId.

    Used for routed editor actions (scene/stop/relaunch — `extra` carries their fields).
    Returns the orchestrator's result dict ``{ok, error, players}``, or
    ``{ok: False, error: 'no_orchestrator'}`` if nothing consumes the command file, or ``{'error': 'timeout'}``
    (with ``unknownOutcome`` and a ``detail`` message when the command was delivered but never answered).
    The MCP never launches/drives an editor itself when routing — this only asks the orchestrator to.
    """
    root = instances._root(project_root)
    request_id = uuid.uuid4().hex

    sock_payload = {"action": action, "projectRoot": str(root)}
    if extra:
        sock_payload.update(extra)
    sock_payload["requestId"] = request_id
    sock_res = await _request_via_socket(root, sock_payload, timeout)
    if sock_res is not None and not (sock_res.get("unknownOutcome") and action in _RESENDABLE_ACTIONS):
        return {k: v for k, v in sock_res.items() if k not in ("type", "id", "status")}

    async with _file_channel:
        return await _request_via_file(root, action, extra, timeout, poll, request_id)


_file_channel = asyncio.Lock()


async def _request_via_file(root: Path, action: str, extra: dict | None, timeout: float, poll: float,
                           request_id: str = "") -> dict:
    cmd_file, res_file = _command_files(root)
    cmd_file.parent.mkdir(parents=True, exist_ok=True)
    ensure_sspace_for(cmd_file.parent)
    request_id = request_id or uuid.uuid4().hex
    try:
        res_file.unlink()
    except OSError:
        pass
    payload = {"action": action}
    if extra:
        payload.update(extra)
    payload["requestId"] = request_id
    cmd_file.write_text(json.dumps(payload), encoding="utf-8")

    deadline = time.monotonic() + timeout
    consumed = False
    while time.monotonic() < deadline:
        await asyncio.sleep(poll)
        if not consumed and not cmd_file.exists():
            consumed = True
        if res_file.exists():
            try:
                data = json.loads(res_file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            if data.get("requestId") == request_id:
                return data
    if not consumed and cmd_file.exists():
        try:
            cmd_file.unlink()
        except OSError:
            pass
        return {"ok": False, "error": "no_orchestrator"}
    if action in _RESENDABLE_ACTIONS:
        return {"ok": False, "error": "timeout"}
    return unknown_outcome(action, f"didn't answer within {int(timeout)} s")
