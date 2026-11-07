import asyncio
import base64
import contextlib
import dataclasses
import importlib
import inspect
import io
import json
import logging
import math
import sys
import time
import traceback
from pathlib import Path


def _decode(v):
    if isinstance(v, list):
        return [_decode(x) for x in v]
    if isinstance(v, dict):
        if len(v) == 1 and "$path" in v:
            return Path(str(v["$path"]))
        if len(v) == 1 and "$bytes" in v:
            return base64.b64decode(str(v["$bytes"]))
        if len(v) == 1 and "$tuple" in v and isinstance(v["$tuple"], list):
            return tuple(_decode(x) for x in v["$tuple"])
        return {k: _decode(x) for k, x in v.items()}
    return v


def _encode(v, depth=0):
    if depth > 20:
        return {"$cut": "too deep"}
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, float):
        return v if math.isfinite(v) else {"$number": str(v)}
    if isinstance(v, Path):
        return str(v)
    if isinstance(v, (bytes, bytearray)):
        try:
            return {"$bytes": bytes(v).decode("utf-8")}
        except UnicodeDecodeError:
            return {"$bytes": base64.b64encode(bytes(v)).decode("ascii"), "base64": True}
    if dataclasses.is_dataclass(v) and not isinstance(v, type):
        out = {"$class": type(v).__name__}
        for f in dataclasses.fields(v):
            out[f.name] = _encode(getattr(v, f.name), depth + 1)
        return out
    if isinstance(v, dict):
        return {str(k): _encode(x, depth + 1) for k, x in v.items()}
    if isinstance(v, (list, tuple, set, frozenset)):
        items = sorted(v, key=repr) if isinstance(v, (set, frozenset)) else v
        return [_encode(x, depth + 1) for x in items]
    if isinstance(v, BaseException):
        return {"$error": {"name": type(v).__name__, "message": str(v)}}
    return {"$repr": repr(v)[:500]}


def _listing(mod):
    rows = []
    for name, obj in sorted(vars(mod).items()):
        if getattr(obj, "__module__", None) != mod.__name__:
            continue
        if inspect.isfunction(obj) or inspect.isclass(obj):
            try:
                sig = str(inspect.signature(obj))
            except (TypeError, ValueError):
                sig = "(...)"
            rows.append({"name": name, "kind": "class" if inspect.isclass(obj) else "async" if inspect.iscoroutinefunction(obj) else "function", "params": sig[:300]})
    return rows


async def _settle(value, timeout):
    if inspect.isawaitable(value):
        return await asyncio.wait_for(value, timeout)
    return value


def run(req: dict) -> dict:
    name = str(req.get("module") or "").strip()
    if not name.startswith("unity_mcp"):
        name = f"unity_mcp.{name}"
    if not all(part.isidentifier() for part in name.split(".")):
        return {"ok": False, "error": {"name": "ValueError", "message": f"bad module name {name}"}}
    mod = importlib.import_module(name)
    if not mod.__name__.startswith("unity_mcp"):
        return {"ok": False, "error": {"name": "ValueError", "message": f"{name} is not part of unity_mcp"}}
    fn = str(req.get("fn") or "").strip()
    if not fn:
        return {"ok": True, "module": name, "value": _listing(mod)}
    target = mod
    for part in fn.split("."):
        target = getattr(target, part)
    args = _decode(req.get("args") or [])
    kwargs = _decode(req.get("kwargs") or {})
    timeout = max(0.1, float(req.get("timeout") or 30))
    out = io.StringIO()
    err = io.StringIO()
    handler = logging.StreamHandler(err)
    logging.getLogger().addHandler(handler)
    logging.getLogger().setLevel(logging.DEBUG)
    t0 = time.monotonic()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            value = target(*args, **kwargs) if callable(target) else target
            value = asyncio.run(_settle(value, timeout)) if inspect.isawaitable(value) else value
        return {"ok": True, "module": name, "fn": fn, "value": _encode(value), "stdout": out.getvalue()[-8000:], "stderr": err.getvalue()[-8000:], "ms": round((time.monotonic() - t0) * 1000)}
    except BaseException as e:
        tb = traceback.format_exc().strip().splitlines()[-14:]
        return {"ok": False, "module": name, "fn": fn, "error": {"name": type(e).__name__, "message": str(e), "traceback": tb}, "stdout": out.getvalue()[-8000:], "stderr": err.getvalue()[-8000:], "ms": round((time.monotonic() - t0) * 1000)}
    finally:
        logging.getLogger().removeHandler(handler)


def main() -> int:
    real = sys.stdout
    try:
        req = json.loads(sys.stdin.read() or "{}")
        reply = run(req if isinstance(req, dict) else {})
    except BaseException as e:
        reply = {"ok": False, "error": {"name": type(e).__name__, "message": str(e), "traceback": traceback.format_exc().strip().splitlines()[-14:]}}
    real.write(json.dumps(reply, default=str) + "\n")
    real.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
