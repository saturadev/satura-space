# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Satura Space MCP server.

Produces a single-file, console executable named `satura-space-mcp` from
`server.py`. The server speaks the MCP protocol over stdio (FastMCP), so it MUST
stay a console app and must not swallow stdin/stdout.

Build:
    node apps/orchestrator/scripts/build-mcp.mjs [--force]

Always build through that script, never PyInstaller directly: it generates
`unity_mcp/_build_info.py`, which bakes the product version the frozen server needs to tell
whether Satura Space has moved past it (`unity_mcp/version_guard.py`). A hand-built binary
carries a stale version — or none, silently disabling the guard.

Output:
    dist/satura-space-mcp   (the standalone binary, copied to the orchestrator's resources/mcp)
"""

from PyInstaller.utils.hooks import collect_submodules

# FastMCP / MCP and our own tool modules register tools via import side-effects and
# pull a lot in dynamically, so freezing commonly misses them. Collect everything
# under `mcp` and `unity_mcp`, then belt-and-suspenders the critical names.
hiddenimports = []
hiddenimports += collect_submodules('mcp')
hiddenimports += collect_submodules('unity_mcp')
hiddenimports += [
    'mcp',
    'mcp.server',
    'mcp.server.fastmcp',
    'unity_mcp',
    'unity_mcp.tools_bridge',
    'unity_mcp.tools_instances',
    'yaml',
]

a = Analysis(
    ['server.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='satura-space-mcp',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
