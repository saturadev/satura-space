"""Python mirror of the control-protocol codec (apps/orchestrator/src/shared/control-protocol.ts).

NDJSON framing for the MCP's socket clients (→ editor control socket, → orchestrator control socket):
one JSON object per ``\\n``-terminated line. Pure/async building blocks, no socket I/O here. The MCP
is only ever a CLIENT, so this carries the encoder, the streaming parser, and the client-side
request/response correlator.
"""
import json

def encode_message(msg: dict) -> bytes:
    """One newline-terminated JSON line, UTF-8 (compact — matches the TS encoder)."""
    return (json.dumps(msg, separators=(",", ":")) + "\n").encode("utf-8")

class NdjsonParser:
    """Accumulate string/bytes chunks; yield one parsed control message per complete ``\\n`` line.

    Partial trailing lines buffer until finished; blank or malformed lines are skipped (never raise),
    so a corrupt line cannot desync the stream. Only dict messages carrying a string ``type`` pass.
    """

    def __init__(self) -> None:
        self._buf = ""

    def push(self, chunk) -> list[dict]:
        if isinstance(chunk, (bytes, bytearray)):
            chunk = bytes(chunk).decode("utf-8", errors="replace")
        self._buf += chunk
        out: list[dict] = []
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            line = line.strip()
            if not line:
                continue
            try:
                m = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(m, dict) and isinstance(m.get("type"), str):
                out.append(m)
        return out
