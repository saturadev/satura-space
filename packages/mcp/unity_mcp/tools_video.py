from typing import Annotated, Literal

from pydantic import Field

from .params import ProjectRoot
from .helpers import resolve_root, tool_guard
from .multiplayer import orchestrator_present, request_player_command, resolve_player_dir

_OPS = ("start", "stop", "finish", "clear_buffer", "status")
_NOT_MANAGED = (
    "ERROR: video recording films the Unity panel of the Satura Space app, and the app is not managing "
    "this project. Open the project in Satura Space and add a Unity Player panel, then retry."
)


def _fmt_seconds(v) -> str:
    try:
        return f"{float(v):.1f}s"
    except (TypeError, ValueError):
        return "?"


def _describe(op: str, v: dict) -> str:
    if op == "finish":
        size = f"{v.get('width')}x{v.get('height')}"
        sound = "with sound" if v.get("audio") else "muted"
        mb = (v.get("bytes") or 0) / 1_000_000
        dropped = f", {v.get('dropped')} dropped" if v.get("dropped") else ""
        return (
            f"Saved {v.get('path')}\n"
            f"{_fmt_seconds(v.get('seconds'))}, {size}, {sound}, {v.get('frames')} frames{dropped}, "
            f"{v.get('segments')} segment(s), {v.get('codec')}, {mb:.1f} MB.\n"
            f"Show it to the user: await video.open({v.get('path')!r})"
        )
    state = v.get("state", "empty")
    if state == "empty":
        return "Buffer empty. The stream follows the panel size again."
    size = f"{v.get('width')}x{v.get('height')}"
    sound = "with sound" if v.get("audio") else "muted"
    line = f"{state.capitalize()}: {_fmt_seconds(v.get('seconds'))} in {v.get('segments')} segment(s), {size}, {sound}."
    if v.get("limit"):
        line += f" {v['limit']}."
    if v.get("waiting"):
        line += (
            " No frames yet. The Unity Player panel streams only in Play Mode, and the recording starts at its"
            " first frame."
        )
    elif v.get("frames") == 0 and state == "paused":
        return line + " Nothing recorded: no frames arrived, because the panel streams only in Play Mode. Enter Play and start again, or clear the buffer."
    if state == "paused":
        line += " start continues the same video; finish saves it."
    return line


@tool_guard
async def unity_video(
    op: Annotated[Literal["start", "stop", "finish", "clear_buffer", "status"], Field(description="What to do, see the list above.")],
    audio: Annotated[bool | None, Field(description="start: record the game's sound (Play Mode only).")] = None,
    size: Annotated[str, Field(description='start: "WIDTHxHEIGHT", or one number for the long side. Default 1920x1080.')] = "",
    path: Annotated[str, Field(description="finish: output file, absolute or relative to the project. Default .sspace/videos/video-<time>.mp4.")] = "",
    player: Annotated[str, Field(description="Which editor: primary, a 1-based player number or a clone id. Default primary.")] = "",
    project_root: ProjectRoot = "",
) -> str:
    op = (op or "").strip().lower()
    if op not in _OPS:
        return f"ERROR: op must be one of {', '.join(_OPS)}; got {op!r}."
    root, player_dir = resolve_player_dir(resolve_root(project_root))
    if not (root / "Assets").is_dir():
        return f"ERROR: Not a Unity project: {root}"
    if not orchestrator_present(str(root)):
        return _NOT_MANAGED
    args: dict = {"op": op}
    if op == "start":
        if audio is not None:
            args["audio"] = bool(audio)
        if str(size).strip():
            args["size"] = str(size).strip()
    if op == "finish" and path.strip():
        args["path"] = path.strip()
    who = (player or "").strip() or player_dir or "primary"
    timeout = 150.0 if op == "finish" else 20.0
    r = await request_player_command(str(root), "video", extra={"target": who, "video": args}, timeout=timeout)
    if r.get("error") == "no_orchestrator":
        return _NOT_MANAGED
    if r.get("error") == "timeout":
        return f"ERROR: Satura Space did not answer video.{'clear' if op == 'clear_buffer' else op}() within {int(timeout)}s. Check video.status()."
    if not r.get("ok"):
        return f"ERROR: {r.get('error') or 'unknown'}"
    v = r.get("video") or {}
    out = _describe(op, v) if isinstance(v, dict) else "Done."
    note = r.get("note")
    if note:
        out += f"\nNote: {note}"
    return out
