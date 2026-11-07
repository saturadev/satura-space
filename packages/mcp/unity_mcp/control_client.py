"""MCP → Unity editor control-socket helpers.

``write_trigger`` writes a ``.mcp_*_trigger.json`` file directly — the reload-proof path the editor's
OnUpdate poll reads. Only the quit trigger still uses it; every other editor op goes through the
single command-log queue (``commands.json`` / ``command_acks.json``).
"""

from .sspace import ensure_sspace

def write_trigger(project_root, name: str, body: str) -> None:
    """Write a command trigger to its ``<.sspace>/<name>`` file — the reliable, reload-proof path the
    editor's OnUpdate poll reads. (Trigger-over-socket was dropped: a fire-and-forget send is lost if
    the connection is mid-churn across one of Unity's frequent domain reloads, stranding the command.)"""
    ss = ensure_sspace(project_root)
    (ss / name).write_text(body)
