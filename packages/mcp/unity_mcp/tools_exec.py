import asyncio
import base64
import json
import os
import re
import time
from pathlib import Path
from typing import Annotated

from mcp.server.fastmcp import Context, Image
from pydantic import Field

from . import GUIDE, mcp
from . import exec_ops
from .helpers import resolve_root, tool_guard

PANE_KEY_ENV = "SATURA_PANE_KEY"
ENDPOINT_ENV = "SATURA_AGENT_HOOKS_ENDPOINT"
EXEC_PATH = "/exec"
ANSWER_PATH = "/exec/answer"
TOKEN_HEADER = "X-Satura-Hook-Token"
DEFAULT_TIMEOUT = 300.0
MAX_TIMEOUT = 3600.0
REPLY_MARGIN = 30.0
PAUSE_ALLOWANCE = 7200.0
CONNECT_TIMEOUT = 5.0
IDLE_TIMEOUT = 60.0
MAX_CODE = 200_000
MAX_ANSWER_BYTES = 60 * 1024 * 1024
CLEANUP_TIMEOUT = 30.0
RECORDING_STOPPED = "The script stopped while recording video, so the recording was stopped. video.finish() still saves what was recorded."
RECORDING_LEFT = "A video recording this script started is still running: stop it with video.stop(), or save it with video.finish()."
SAVED_VIDEO = re.compile(r"Saved (\S+\.mp4)")
VIDEO_SAVED = "The video was saved before the script stopped: {}"
DRIFT_USE = re.compile(r"\bdrift\.(show|say|ask)\s*\(")

NO_APP = (
    "Satura Space isn't running, and satura_exec runs inside the app. Open this project in Satura "
    "Space and run the agent in one of its terminal tabs."
)
NO_REPLY = "Satura Space didn't answer. Check that the app is running, then retry."
OLD_APP = "This version of Satura Space is older than its MCP server. Update the app."


def endpoint_path() -> Path:
    override = (os.environ.get(ENDPOINT_ENV) or "").strip()
    return Path(override) if override else Path.home() / ".satura" / "agent-hooks" / "endpoint"


def read_endpoint(path: Path | None = None) -> tuple[int, str] | None:
    try:
        text = (path or endpoint_path()).read_text(encoding="utf-8")
    except OSError:
        return None
    fields = {}
    for line in text.splitlines():
        key, _, value = line.partition("=")
        fields[key.strip()] = value.strip()
    try:
        port = int(fields.get("port") or 0)
    except ValueError:
        return None
    token = fields.get("token") or ""
    return (port, token) if port > 0 and token else None


def pane_key() -> str:
    key = (os.environ.get(PANE_KEY_ENV) or "").strip()
    if not key or "${" in key or any(c.isspace() for c in key):
        return ""
    return key


def clamp_timeout(timeout) -> float:
    try:
        value = float(timeout)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT
    if value != value or value <= 0:
        return DEFAULT_TIMEOUT
    return min(MAX_TIMEOUT, max(1.0, value))


def build_payload(code: str, timeout, pane: str, project_root: str, drift: bool = False) -> tuple[dict | None, str | None]:
    if not (code or "").strip():
        return None, "Pass a script in code."
    if len(code) > MAX_CODE:
        return None, f"The script is too long: keep it under {MAX_CODE} characters."
    payload = {"code": code, "timeout": clamp_timeout(timeout), "projectRoot": project_root, "drift": drift is True or bool(DRIFT_USE.search(code)), "peer": True}
    if pane:
        payload["paneKey"] = pane
    return payload, None


def _request(port: int, path: str, token: str, body: bytes) -> bytes:
    head = (
        f"POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n{TOKEN_HEADER}: {token}\r\nConnection: close\r\n\r\n"
    )
    return head.encode("latin-1") + body


async def post_answer(port: int, token: str, answer: dict) -> None:
    reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), CONNECT_TIMEOUT)
    try:
        writer.write(_request(port, ANSWER_PATH, token, json.dumps(answer).encode("utf-8")))
        await writer.drain()
        await asyncio.wait_for(reader.read(), 30)
    finally:
        writer.close()


async def _headers(reader) -> tuple[int, dict]:
    raw = await reader.readuntil(b"\r\n\r\n")
    lines = raw.decode("latin-1").split("\r\n")
    status = int(lines[0].split()[1])
    headers = {}
    for line in lines[1:]:
        key, _, value = line.partition(":")
        if key.strip():
            headers[key.strip().lower()] = value.strip().lower()
    return status, headers


async def _body_chunks(reader, chunked: bool):
    if not chunked:
        while True:
            data = await asyncio.wait_for(reader.read(65536), IDLE_TIMEOUT)
            if not data:
                return
            yield data
    while True:
        line = await asyncio.wait_for(reader.readline(), IDLE_TIMEOUT)
        if not line:
            return
        size = int(line.split(b";")[0].strip() or b"0", 16)
        if size == 0:
            return
        data = await asyncio.wait_for(reader.readexactly(size), IDLE_TIMEOUT)
        await asyncio.wait_for(reader.readexactly(2), IDLE_TIMEOUT)
        yield data


_cleanups: set[asyncio.Task] = set()


def _video_of(fn: str, args) -> tuple[str, tuple[str, str]] | None:
    if fn != "video" or not isinstance(args, dict):
        return None
    player = str(args.get("player") or "").strip()
    return str(args.get("op") or ""), (str(args.get("project") or ""), "" if player in ("primary", "1") else player)


async def _stop_recordings(recording: dict, root: str) -> None:
    for project, player in list(recording):
        args = {"op": "stop", **({"player": player} if player else {}), **({"project": project} if project else {})}
        try:
            await asyncio.wait_for(exec_ops.dispatch("video", args, root), CLEANUP_TIMEOUT)
        except Exception:
            pass
    recording.clear()


def _add_note(reply: dict, note: str) -> None:
    if reply.get("error"):
        reply["error"] = f"{reply['error']} {note}"
        return
    notes = reply.get("notes") if isinstance(reply.get("notes"), list) else []
    reply["notes"] = [*notes, note]


async def run_script(payload: dict, deadline: float, root: str, progress=None) -> dict:
    ep = read_endpoint()
    if ep is None:
        return {"ok": False, "error": NO_APP}
    port, token = ep
    tasks: set[asyncio.Task] = set()
    recording: dict = {}
    stopped: list[str] = []
    saved: list[str] = []
    exec_ops.cleanup_notes.set(stopped)

    async def serve(msg: dict) -> None:
        answer = {"run": msg.get("run"), "id": msg.get("id")}
        fn = str(msg.get("fn") or "")
        args = msg.get("args") or {}
        video = _video_of(fn, args)
        if progress is not None:
            await progress(fn)
        try:
            res = await exec_ops.dispatch(fn, args, root)
            answer.update(ok=True, **res)
            if video and video[0] == "start":
                recording[video[1]] = True
            elif video and video[0] in ("stop", "finish"):
                recording.pop(video[1], None)
            if video and video[0] == "finish":
                found = SAVED_VIDEO.search(json.dumps(res))
                if found:
                    saved.append(found.group(1))
        except exec_ops.OpError as e:
            answer.update(ok=False, name=e.name, error=str(e))
        except Exception as e:
            answer.update(ok=False, name="UnityError", error=f"{fn} failed in the MCP server: {type(e).__name__}: {e}")
        size = len(json.dumps(answer).encode("utf-8"))
        if size > MAX_ANSWER_BYTES:
            answer = {"run": answer["run"], "id": answer["id"], "ok": False, "name": "UnityError",
                      "error": f"{fn} answered with {size / 1048576:.0f} MB, more than the {MAX_ANSWER_BYTES / 1048576:.0f} MB a call can pass back. "
                               "Ask for less, like fewer screenshot poses or fewer log lines."}
        try:
            await post_answer(port, token, answer)
        except (OSError, asyncio.TimeoutError):
            try:
                await post_answer(port, token, {"run": answer["run"], "id": answer["id"], "ok": False, "name": "UnityError",
                                                "error": f"{fn} finished, but its answer didn't reach Satura Space. Retry the call."})
            except (OSError, asyncio.TimeoutError):
                pass

    async def talk() -> dict:
        reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), CONNECT_TIMEOUT)
        try:
            writer.write(_request(port, EXEC_PATH, token, json.dumps(payload).encode("utf-8")))
            await writer.drain()
            status, headers = await asyncio.wait_for(_headers(reader), IDLE_TIMEOUT)
            if status == 404:
                return {"ok": False, "error": OLD_APP}
            if status != 200:
                return {"ok": False, "error": NO_REPLY}
            carry = b""
            async for data in _body_chunks(reader, headers.get("transfer-encoding") == "chunked"):
                carry += data
                *lines, carry = carry.split(b"\n")
                for line in lines:
                    if not line.strip():
                        if progress is not None:
                            await progress("")
                        continue
                    msg = json.loads(line.decode("utf-8"))
                    if msg.get("t") == "call":
                        task = asyncio.create_task(serve(msg))
                        tasks.add(task)
                        task.add_done_callback(tasks.discard)
                    elif msg.get("t") == "done":
                        return msg.get("reply") or {"ok": False, "error": NO_REPLY}
            if carry.strip():
                data = json.loads(carry.decode("utf-8"))
                if isinstance(data, dict) and data.get("t") == "done":
                    return data.get("reply") or {"ok": False, "error": NO_REPLY}
                if isinstance(data, dict) and "ok" in data:
                    return data
            return {"ok": False, "error": NO_REPLY}
        finally:
            writer.close()

    try:
        reply = await asyncio.wait_for(talk(), deadline)
    except asyncio.TimeoutError:
        reply = {"ok": False, "error": f"Satura Space didn't answer within {int(deadline)} seconds."}
    except (OSError, ValueError, IndexError, UnicodeDecodeError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        reply = {"ok": False, "error": NO_REPLY}
    except asyncio.CancelledError:
        if recording:
            cleanup = asyncio.get_running_loop().create_task(_stop_recordings(recording, root))
            _cleanups.add(cleanup)
            cleanup.add_done_callback(_cleanups.discard)
        raise
    finally:
        for task in list(tasks):
            task.cancel()
    if tasks:
        await asyncio.wait(list(tasks), timeout=exec_ops.STOP_ON_CANCEL + 5)
    for note in stopped:
        _add_note(reply, note)
    if isinstance(reply, dict) and (reply.get("failure") or reply.get("error")):
        for path in saved:
            _add_note(reply, VIDEO_SAVED.format(path))
    if recording:
        if not isinstance(reply, dict):
            reply = {"ok": False, "error": NO_REPLY}
        if reply.get("ok") and not reply.get("failure"):
            _add_note(reply, RECORDING_LEFT)
        else:
            await _stop_recordings(recording, root)
            _add_note(reply, RECORDING_STOPPED)
    return reply


def readable(value, indent: str = "") -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        if not value:
            return "{}"
        lines = []
        for k, v in value.items():
            if isinstance(v, (dict, list)) and v:
                lines.append(f"{indent}{k}:")
                lines.append(readable(v, indent + "  "))
            elif isinstance(v, str) and "\n" in v:
                lines.append(f"{indent}{k}: |")
                lines += [f"{indent}  {l}" for l in v.splitlines()]
            else:
                lines.append(f"{indent}{k}: {_scalar(v)}")
        return "\n".join(lines)
    if isinstance(value, list):
        if not value:
            return "[]"
        if all(v is None or isinstance(v, (bool, int, float)) for v in value):
            line = ", ".join(_scalar(v) for v in value)
            if len(line) <= 100:
                return f"{indent}[{line}]"
        lines = []
        for v in value:
            body = readable(v, indent + "  ")
            if isinstance(v, (dict, list)) and v:
                lines.append(f"{indent}- " + body.lstrip())
            elif isinstance(v, str) and "\n" in v:
                lines.append(f"{indent}- |")
                lines += [f"{indent}  {l}" for l in v.splitlines()]
            else:
                lines.append(f"{indent}- {_scalar(v)}")
        return "\n".join(lines)
    return f"{indent}{_scalar(value)}"


def _scalar(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return v
    return json.dumps(v)


def _result_text(raw) -> str:
    if raw is None:
        return ""
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return str(raw)
    return readable(value)


def _failure_text(failure: dict) -> list[str]:
    name = failure.get("name") or "Error"
    message = failure.get("message") or ""
    lines = [f"ERROR: {name}: {message}" if message else f"ERROR: {name}"]
    stack = [l for l in (failure.get("stack") or "").splitlines() if l.strip().startswith("at ")]
    lines += [f"  {l.strip()}" for l in stack]
    if name == "SyntaxError" and failure.get("stack") and not stack:
        lines += [f"  {l}" for l in failure["stack"].splitlines()[:4] if l.strip()]
    return lines


def _steps_text(steps: list) -> str:
    parts = []
    for s in steps:
        label = s.get("label") or "?"
        secs = (s.get("ms") or 0) / 1000
        timing = f" {secs:.1f}s" if secs >= 0.5 else ""
        parts.append(f"{label}{timing}" if s.get("ok") else f"FAILED {label}{timing}")
    return " · ".join(parts)


def format_reply(res: dict):
    if res.get("error"):
        return f"ERROR: {res['error']}"
    lines = []
    failure = res.get("failure")
    if failure:
        lines += _failure_text(failure)
    else:
        text = _result_text(res.get("result"))
        lines.append(text if text.strip() else "Done, no return value.")
    steps = res.get("steps") or []
    if steps:
        lines.append(f"\nSteps: {_steps_text(steps)}")
    notes = res.get("notes") or []
    if notes:
        lines.append("Notes:")
        lines += [f"  {n}" for n in notes]
    if res.get("drift"):
        lines.append(f"Drift: {res['drift']}")
    logs = res.get("logs") or []
    if logs:
        lines.append("Console:")
        for entry in logs:
            level = entry.get("level") or "log"
            prefix = "" if level in ("log", "info") else f"[{level}] "
            lines.append(f"  {prefix}{entry.get('text', '')}")
    images = []
    for shot in res.get("shots") or []:
        fmt = "jpeg" if "jpeg" in (shot.get("mime") or "") else "png"
        try:
            images.append(Image(data=base64.b64decode(shot.get("data") or ""), format=fmt))
        except ValueError:
            continue
    if images:
        lines.append(f"Images: {len(images)}, attached below.")
    text = "\n".join(lines)
    return [text, *images] if images else text


SLOW_EXEC_SECONDS = 4.0


def progress_message(fn: str, seconds: float) -> str:
    if not fn:
        return "The script is running"
    if fn.startswith("unity.exec") and seconds >= SLOW_EXEC_SECONDS:
        return (f"Running {fn} ({seconds:.0f} s). The first unity.exec after the editor starts or recompiles "
                "warms up the C# compiler and can take up to about 25 s: keep waiting, the editor is not stuck.")
    return f"Running {fn}"


SHEET = """Run JavaScript inside Satura Space: the Unity editors, the game, handles, logs, video, reports, Tuners, Drift and the app's UI. The script is the body of an async function: await every call and return what you want back. A failed call throws with the reason.

Read {guide} before your first script. It links one short file per API.

- Answer questions by showing: drift.look to find out, then 2 to 6 drift.show lines, then a short reply. Change nothing while answering.
- Never save scenes, prefabs or assets unless the user asked.
- Test exactly what changed, in short runs. Regression passes only when the user asks.
- Unity runs only on the Input System package; otherwise launches throw InputSystemRequired.
- Waits end early with the reason. Read it; a longer timeout won't help.

unity.status() / exec(cs) / refresh() / play(scene?) / stop() / logs() / screenshot(pose)
handles.list(group?) / handles.call('Group/Name', ...args): groups follow classes, keep them flat; staging scenarios are handles too
video.record(fn) / video.cameras(cams, fn) / report.open(path)
tuner.open({{...}}) / drift.look(target) / drift.show(target, text)
app.tabs() / app.switchTab(tab, {{ phone: true }}) / app.phone(): switch tabs on the Mac and the user's phone, and see which panel the phone shows
dashboard, scratchpad, env, page (Playwright), agents: see the guide"""

EXEC_DESCRIPTION = SHEET.format(guide=GUIDE)


@mcp.tool(description=EXEC_DESCRIPTION)
@tool_guard
async def satura_exec(
    code: Annotated[str, Field(description="The script: the body of an async function.")],
    timeout: Annotated[float, Field(description="Seconds before the script is stopped, default 300, at most 3600. Time paused for the user doesn't count.")] = DEFAULT_TIMEOUT,
    drift: Annotated[bool, Field(description="Show Drift for the lower-level helpers in the guide. drift.show, say and ask turn it on by themselves.")] = False,
    project_root: Annotated[str, Field(description="Only needed outside a Satura Space terminal tab.")] = "",
    ctx: Context | None = None,
):
    root = resolve_root(project_root)
    payload, error = build_payload(code, timeout, pane_key(), root, drift)
    if error:
        return f"ERROR: {error}"
    beats = 0
    current = {"fn": "", "at": time.monotonic()}

    async def progress(fn: str):
        nonlocal beats
        beats += 1
        if fn:
            current["fn"] = fn
            current["at"] = time.monotonic()
        if ctx is None:
            return
        try:
            await ctx.report_progress(beats, message=progress_message(current["fn"], time.monotonic() - current["at"]))
        except Exception:
            pass

    return format_reply(await run_script(payload, payload["timeout"] + REPLY_MARGIN + PAUSE_ALLOWANCE, root, progress))
