import argparse
import asyncio
import json
import os
import sys

from . import tools_exec
from .helpers import resolve_root


async def run(request: dict, root: str, deadline: float) -> dict:
    payload, error = tools_exec.build_payload(str(request.get("code") or ""), request.get("timeout"), "", root, request.get("drift") is True)
    if error:
        return {"ok": False, "error": error}
    if isinstance(request.get("caller"), str):
        payload["caller"] = request["caller"]
    return await tools_exec.run_script(payload, deadline, root)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m unity_mcp.exec_cli")
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--deadline", type=float, required=True)
    args = parser.parse_args(argv)
    os.environ[tools_exec.ENDPOINT_ENV] = args.endpoint
    out = sys.stdout
    sys.stdout = sys.stderr
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if not isinstance(payload, dict):
            raise ValueError("the request must be a JSON object")
        reply = asyncio.run(run(payload, resolve_root(args.root), args.deadline))
    except ValueError as e:
        reply = {"ok": False, "error": f"Bad request from the CLI: {e}"}
    finally:
        sys.stdout = out
    out.write(json.dumps(reply) + "\n")
    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
