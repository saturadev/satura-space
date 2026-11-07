import asyncio
from pathlib import Path

from typing import Annotated, Literal

from pydantic import Field

from . import scratchpads
from .helpers import tool_guard


def _line(s: dict) -> str:
    head = s.get("status") or "?"
    if s.get("pid"):
        head += f" pid={s['pid']}"
    if s.get("lifecycle") and s.get("status") == "running":
        head += f" {s['lifecycle']}"
    if s.get("unityMode") and s["unityMode"] != "normal":
        head += f" {s['unityMode']}"
    tail = f"  error: {s['error']}" if s.get("error") else ""
    return f"[{head}] {s.get('name')}  id={s.get('id')}  {s.get('path')}{tail}"


def _fail(r: dict) -> str:
    return "ERROR: " + (r.get("error") or "unknown")


async def _settle(project_root: str, info: dict, want: tuple, wait_seconds: int) -> dict:
    if wait_seconds <= 0 or info.get("status") in want:
        return {"ok": True, "scratchpad": info}
    return await scratchpads.wait_for_status(project_root, info["id"], want, float(wait_seconds))


def _started_report(verb: str, info: dict) -> str:
    status = info.get("status")
    if status == "error":
        return (f"ERROR: Scratchpad {info.get('name')} (id={info.get('id')}) did not start.\n"
                f"{info.get('error') or 'Its editor failed.'}\n"
                f"Fix the errors in {info.get('path')}, then scratchpad.restart('{info.get('id')}'). "
                "Starting it again without a fix fails the same way.")
    lines = [f"{verb}: {_line(info)}"]
    if status == "running":
        lines.append(f"Work in it through the object this call returns, or unity.at('{info['path']}'): the same calls as unity, "
                     "like .refresh(), .exec(), .openScene(), .screenshot(), .logs(), .players(), .addPlayer() and .removePlayer().")
    elif status == "starting":
        lines.append("Still starting — a fresh scratchpad imports its packages on first boot. Poll "
                     "scratchpad.list(), or watch .logs() on the object this call returns.")
    return "\n".join(lines)


_COMMANDS = ("list", "create", "start", "stop", "restart", "rename", "remove")
_START_WAIT = 300
_STOP_WAIT = 60


@tool_guard
async def unity_scratchpad(
    command: Annotated[Literal["list", "create", "start", "stop", "restart", "rename", "remove"], Field(description="What to do, see the list above.")],
    scratchpad: Annotated[str, Field(description="Its id or name. Needed by start, stop, restart, rename and remove.")] = "",
    name: Annotated[str, Field(description='create: display name, unique in the project (default "Scratchpad N"). rename: the new name.')] = "",
    start: Annotated[bool, Field(description="create: start its editor right away.")] = True,
    wait_seconds: Annotated[int | None, Field(description="How long to wait for the editor to settle, 0 returns at once. Default 300 for create, start and restart; 60 for stop.")] = None,
    project_root: Annotated[str, Field(description="The main Unity project. Leave empty for this project; a scratchpad path is read as its parent project.")] = "",
) -> str:
    cmd = (command or "").strip().lower()
    if cmd not in _COMMANDS:
        return f"ERROR: Unknown command {command!r}. Use one of: {', '.join(_COMMANDS)}."
    if cmd not in ("list", "create") and not (scratchpad or "").strip():
        return f"ERROR: scratchpad.{cmd}(id) needs the scratchpad's id or name."
    if cmd == "rename" and not (name or "").strip():
        return "ERROR: scratchpad.rename(id, name) needs the new name."
    wait = (_STOP_WAIT if cmd == "stop" else _START_WAIT) if wait_seconds is None else wait_seconds
    if cmd == "list":
        return await _list(project_root)
    if cmd == "create":
        return await _create(name, start, wait, project_root)
    if cmd == "start":
        return await _start(scratchpad, wait, project_root)
    if cmd == "stop":
        return await _stop(scratchpad, wait, project_root)
    if cmd == "restart":
        return await _restart(scratchpad, wait, project_root)
    if cmd == "rename":
        return await _rename(scratchpad, name, project_root)
    return await _remove(scratchpad, project_root)


async def _list(project_root: str) -> str:
    r = await scratchpads.request(project_root, "list")
    if not r.get("ok"):
        return _fail(r)
    items = r.get("scratchpads") or []
    if not items:
        return "No scratchpads. Create one with scratchpad.create(name)."
    return "\n".join(_line(s) for s in items)


async def _create(name: str, start: bool, wait_seconds: int, project_root: str) -> str:
    r = await scratchpads.request(project_root, "create", name=name or None)
    if not r.get("ok"):
        return _fail(r)
    info = r["scratchpad"]
    if not start:
        return (f"Created: {_line(info)}\nStart it with "
                f"scratchpad.start('{info['id']}').")
    r = await scratchpads.request(project_root, "start", scratchpad=info["id"])
    if not r.get("ok"):
        return f"Created: {_line(info)}\n" + _fail(r)
    s = await _settle(project_root, r["scratchpad"], scratchpads.SETTLED_STATUSES, wait_seconds)
    if not s.get("ok"):
        return _fail(s)
    return _started_report("Created", s["scratchpad"])


async def _start(scratchpad: str, wait_seconds: int, project_root: str) -> str:
    r = await scratchpads.request(project_root, "start", scratchpad=scratchpad)
    if not r.get("ok"):
        return _fail(r)
    s = await _settle(project_root, r["scratchpad"], scratchpads.SETTLED_STATUSES, wait_seconds)
    if not s.get("ok"):
        return _fail(s)
    return _started_report("Started", s["scratchpad"])


async def _stop(scratchpad: str, wait_seconds: int, project_root: str) -> str:
    r = await scratchpads.request(project_root, "stop", scratchpad=scratchpad)
    if not r.get("ok"):
        return _fail(r)
    s = await _settle(project_root, r["scratchpad"], ("stopped", "error"), wait_seconds)
    if not s.get("ok"):
        return _fail(s)
    return f"Stop requested: {_line(s['scratchpad'])}"


async def _restart(scratchpad: str, wait_seconds: int, project_root: str) -> str:
    r = await scratchpads.request(project_root, "restart", scratchpad=scratchpad)
    if not r.get("ok"):
        return _fail(r)
    s = await _settle(project_root, r["scratchpad"], scratchpads.SETTLED_STATUSES, wait_seconds)
    if not s.get("ok"):
        return _fail(s)
    return _started_report("Restarted", s["scratchpad"])


async def _rename(scratchpad: str, name: str, project_root: str) -> str:
    r = await scratchpads.request(project_root, "rename", scratchpad=scratchpad, name=name)
    if not r.get("ok"):
        return _fail(r)
    return f"Renamed: {_line(r['scratchpad'])}"


async def _remove(scratchpad: str, project_root: str) -> str:
    r = await scratchpads.request(project_root, "remove", scratchpad=scratchpad, timeout=300.0)
    if not r.get("ok"):
        return _fail(r)
    return f"Removed scratchpad {scratchpad}."


async def _resolve(project_root: str, scratchpad: str) -> tuple[dict | None, str | None]:
    r = await scratchpads.request(project_root, "list")
    if not r.get("ok"):
        return None, _fail(r)
    items = r.get("scratchpads") or []
    want = (scratchpad or "").strip()
    hit = next((s for s in items if s.get("id") == want), None) or next(
        (s for s in items if (s.get("name") or "").lower() == want.lower()), None)
    if not hit:
        names = ", ".join(f"{s.get('name')} ({s.get('id')})" for s in items) or "none"
        return None, f"ERROR: No scratchpad '{scratchpad}'. Existing: {names}."
    return hit, None


def _transfer_report(res: dict, dest: str) -> str:
    lines = [f"Copied {len(res['copied'])} file(s), {len(res['unchanged'])} already identical."]
    if res["dependencies"]:
        lines.append("Pulled in dependencies: " + ", ".join(res["dependencies"]))
    for key, label in (("conflicts", "SKIPPED"), ("missing", "NOT FOUND"), ("invalid", "INVALID (must be under Assets/)")):
        for item in res[key]:
            lines.append(f"{label}: {item}")
    if res["copied"]:
        lines.append(f"Next: unity.at('{dest}').refresh() so its editor imports them. Script "
                     "dependencies are followed only through asset references, not through code — "
                     "check the console for missing types.")
    return "\n".join(lines)


@tool_guard
async def unity_scratchpad_copy(
    direction: Annotated[Literal["import", "export"], Field(description="import: main project -> scratchpad. export: scratchpad -> main project.")],
    scratchpad: Annotated[str, Field(description="Its id or name.")],
    paths: Annotated[list[str], Field(description='Asset files or folders under Assets/, e.g. ["Assets/Prefabs/Enemy.prefab", "Assets/Shaders"].')],
    overwrite: Annotated[bool, Field(description="Replace destination files whose content differs. Review the conflicts first.")] = False,
    dependencies: Annotated[bool, Field(description="Also copy everything the selection references, recursively.")] = True,
    project_root: Annotated[str, Field(description="The main Unity project. Leave empty for this project.")] = "",
) -> str:
    way = (direction or "").strip().lower()
    if way not in ("import", "export"):
        return f"ERROR: Unknown direction {direction!r}. Use import or export."
    if not [p for p in (paths or []) if str(p).strip()]:
        return f"ERROR: scratchpad.{way}() needs the asset paths to copy, like ['Assets/Prefabs/Enemy.prefab']."
    hit, err = await _resolve(project_root, scratchpad)
    if err:
        return err
    main = scratchpads.main_root(project_root)
    pad = Path(hit["path"])
    src, dst = (main, pad) if way == "import" else (pad, main)
    res = await asyncio.to_thread(scratchpads.transfer, src, dst, paths, overwrite, dependencies)
    report = _transfer_report(res, str(dst))
    if not res["copied"] and not res["unchanged"] and (res["missing"] or res["invalid"]):
        return "ERROR: nothing was copied.\n" + report
    return report
