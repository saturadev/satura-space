# Contributing

Bug reports, fixes and features are welcome. For anything bigger than a fix, open an issue first so
we can agree on the approach before you write the code.

## License

Satura Space is licensed under [Apache-2.0](LICENSE). By opening a pull request you agree that your
contribution is licensed under the same terms (inbound = outbound, as section 5 of the license
says). There's no CLA and no sign-off line to add.

## Layout

| Path | What |
|---|---|
| `apps/orchestrator` | The desktop app (Electron, React). Launches, streams and drives Unity editors. |
| `packages/saturaspace-engine` | Unity package the app embeds into each project, out of git and player builds: the stream server, the editor bridge, C# hot reload, and the game API (`SaturaHandle`, `SaturaLog`, staging prefabs). |
| `packages/mcp` | Python MCP server. Agents use its one tool, `satura_exec`, to drive Unity and the app. |
| `packages/companion-app` | Satura Remote, the phone companion: the relay and the phone site. |
| `tools/` | Build helpers for the vendored engine libraries. |

## Build and run from source

You need:

- macOS on Apple Silicon, or Windows 10/11 x64
- Unity 6 (6000.0 or newer) and Unity Hub, signed in
- Node 24 and pnpm 10 (`corepack pnpm@10.34.9` works without a global install)
- Python 3.12 or newer for the MCP server
- On macOS, the Xcode Command Line Tools; on Windows, Visual Studio with the C++ toolset. The
  install rebuilds node-pty for Electron and builds the app's shared-surface addon.

On Windows, build the two native helpers once before installing, from a PowerShell prompt at the repo
root:

```powershell
apps/orchestrator/resources/winhook/build-win.ps1
packages/saturaspace-engine/.native/sharedsurface/build-win.ps1
```

macOS uses the committed `winhook.dylib` and `SaturaSharedSurface.bundle`. If you change their
sources, rebuild them with the `build.sh` next to each.

Then, on both platforms:

```bash
cd apps/orchestrator
corepack pnpm@10.34.9 install
corepack pnpm@10.34.9 dev
```

Set up the MCP server's Python environment once with `packages/mcp/run.sh` (macOS) or
`python -m venv .venv` and `pip install -r requirements.txt` in `packages/mcp` (Windows).

Packaging and signing are in [`apps/orchestrator/PACKAGING.md`](apps/orchestrator/PACKAGING.md).

## A test project and a dev instance

Check changes on a dev instance, a second copy of the dev app with its own settings, ports and Unity
project, and drive it with app handles instead of clicking around. The full guide, with the
handles and a batched check, is [`apps/orchestrator/DEV-INSTANCE.md`](apps/orchestrator/DEV-INSTANCE.md).
Handles inside a game (`[SaturaHandle]`) are in the engine's agent guide,
[`packages/saturaspace-engine/Documentation~/agent-guide/handles.md`](packages/saturaspace-engine/Documentation~/agent-guide/handles.md).

For the test project, make a copy of any Unity 6 project that uses the Input System (Active Input
Handling set to Input System Package, not Both), or create an empty one from Unity Hub. Point
`SATURA_TEST_PROJECT` at it; handles that write files only run on that project. Then:

```bash
cd apps/orchestrator
export SATURA_TEST_PROJECT=~/projects/my-test-project
corepack pnpm@10.34.9 dev:instance alt
node scripts/satura.mjs --instance alt handle unity.ready
```

Call `unity.ready` first and read `value` and `logs` after every call. If a handle you need is
missing, add one in `src/main/handles` or `src/renderer/src/handles`.

## Checks

There are no automated test suites. A change is checked on a dev instance through handles, as
above. Pull requests run [CI](.github/workflows/ci.yml): the app's typecheck, a byte-compile of the
MCP server and a syntax check of the relay. Run them locally first:

```bash
cd apps/orchestrator
corepack pnpm@10.34.9 typecheck
node scripts/engine-check.mjs --project "$SATURA_TEST_PROJECT"
```

```bash
cd packages/mcp
python -m compileall -q server.py unity_mcp
```

```bash
cd packages/companion-app/relay
for f in src/*.mjs scripts/*.mjs; do node --check "$f"; done
```

`engine-check.mjs` compiles the engine C# against a project that has imported the engine
once. Building the phone site is in
[`packages/companion-app/README.md`](packages/companion-app/README.md).

## Repo rules

- **No code comments**, in any language. Put the reasoning in the pull request or the commit message.
- **No formatter.** The source isn't prettier-formatted; match the style around your change.
- **Commits are one short `type(scope): summary` line** with no body, like
  `fix(engine): bind the stream input socket to loopback`. One feature is one to three commits.
- **Prove it with handles and logs.** Show that a change works with handle output or log lines from a
  dev instance; keep screenshots for visual changes. Don't add test files or test frameworks.
- **The editor runs the engine and MCP it launched with.** After changing `packages/saturaspace-engine`
  or `packages/mcp`, restart the dev app and reopen the project.
- **Leave versions alone.** The app and the engine share one version, bumped together when
  a release is cut.
