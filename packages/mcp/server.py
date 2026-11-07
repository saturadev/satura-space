"""Satura Space — MCP server for driving Unity from an AI agent.

Two halves:
  - Offline asset inspection: parse Unity serialized YAML (.prefab/.unity/.asset/
    .controller/.anim/.mat) and .meta without opening the editor.
  - Live editor work: one tool, satura_exec, runs the agent's JavaScript in the Satura Space app and
    calls back here for the project's Unity editors: open scenes, play, refresh, exec C#, handles.
"""

from unity_mcp import mcp

import unity_mcp.tools_bridge
import unity_mcp.tools_instances
import unity_mcp.tools_players
import unity_mcp.tools_logs
import unity_mcp.tools_source
import unity_mcp.tools_trace
import unity_mcp.tools_dialogs
import unity_mcp.tools_scratchpads
import unity_mcp.tools_tuner
import unity_mcp.tools_video
import unity_mcp.tools_env
import unity_mcp.tools_exec

if __name__ == "__main__":
    mcp.run()
