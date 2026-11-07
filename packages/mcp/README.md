# Unity MCP server (`satura-space`)

The Python MCP server that lets an agent drive Unity. The orchestrator ships it as a frozen
PyInstaller binary and registers it into each project's `.mcp.json`. The dev app runs it from
source instead, as `.venv/bin/python server.py` (`.venv\Scripts\python.exe` on Windows), so create
`.venv` once with `./run.sh`.

The server registers one tool, `satura_exec`. The agent writes the body of an async JavaScript
function; the Satura Space app runs it in a sandboxed worker with these globals: `unity` (status,
exec, refresh, play, openScene, stop, logs, screenshot, players, addPlayer, removePlayer, fps,
capFps, uncapFps, resolution, mode, setMode, dialogs, answer, closeDialog, relaunch, shutdown,
trace, traceReport, source, docs, at), `handles`, `video`, `report`, `dashboard`, `tuner`, `drift`,
`scratchpad`, `env`, `page`, `app`, `agents`, `logs` and the helpers `snapshot`, `shot`, `show`,
`point`, `say`, `ask` and `sleep`. The full API, with examples, is the
agent guide in the engine package, `Documentation~/agent-guide.md`; the tool description is a short
sheet that points there.

How a call travels: the server POSTs the script to the app's agent-hook server (`/exec`, with
`peer: true`) and keeps the response open. The app streams NDJSON lines back: `call` lines for every
`unity.*`, `handles.*`, `video.*` (except `open`), `scratchpad.*`, `env.*` and filtered
`tuner.open` call, which the server runs locally (`unity_mcp/exec_ops.py` dispatches to the tool
functions in `tools_*.py`) and answers with a POST to `/exec/answer`; then one `done` line with the
script's result, steps, notes, console lines and images. The server turns that into plain text plus
images. A failed Unity call becomes a thrown `UnityError`, `CompileError`, `HandleError`,
`DialogBlocked`, `UnityTimeout`, `HandleTimeout` or `TypeError` in the script. Scripts that don't
come from this server or the dev CLI (`satura.mjs exec`, which runs `python -m unity_mcp.exec_cli`),
such as report buttons, have no peer, so only the app API works in them.

The editor talks to the server through files: the editor package (`MCPTestBridge`,
`[InitializeOnLoad]`) polls `.sspace/.mcp_*.json` triggers and writes results back. The server
**detects** multiplayer clones but never launches them. The orchestrator owns their lifecycle, and
agents add or remove players with `unity.addPlayer()` and `unity.removePlayer()`.

**Blocking dialogs.** A modal halts Unity's main thread, so no queued command can run. Editors
launched with the native window hook publish open dialogs to `.sspace/.modal_status.json` and take
click/close commands from `.modal_cmd.json`, so the tools return `BLOCKED BY DIALOG` with the
dialog contents in ~1s instead of timing out. Answer with `unity.answer(button)` and retry.

**Tuner.** `tuner.open()` with a filter writes a view to `.sspace/tuners/<name>.json` and asks the app to open it.
A view is one of two kinds. A UI Tuner (`ui`) names a Canvas or an object under one, shows that
object and everything under it in its hierarchy, and draws the whole canvas. A GameObjects Tuner
(`objects`) lists GameObjects of the loaded scenes, and an entry with `children: true` brings its
whole subtree along. Passing both is an error, and `merge` cannot switch a view from one kind to the
other. Objects that come in through a parent can be selected, inspected and edited like listed ones,
so a screen of UI is one `ui` root rather than hundreds of entries. Both kinds can add assets such
as ScriptableObjects and materials, and toolbar buttons that call a parameterless method. A button
can carry a `tip`, work only in one `mode` (`play` or `edit`), or join a numbered `step` list that
unlocks in order, which suits a demo that runs in Play Mode. Filters
keep the inspector down to what a tweak needs. An object shows every component, only the `components` you list, every component but the
ones in `exclude`, or just its header (`components: []`). A component or asset shows every
property, only its `fields`, every property but the (possibly nested) paths in `exclude`, or just
its title bar (`fields: []`). `exclude` keeps a custom editor and its buttons, while `fields` draws
the listed properties with Unity's `PropertyField` in place of the custom editor, each one under its
parent foldouts (a ParticleSystem field under its module). The panel shows
a scene view with only those objects, their hierarchy and Unity's own Inspector for the selected
entry, and the user can open more objects and assets from it. It works in Edit Mode and
Play Mode and saves the way Unity does. In Edit Mode each change goes into the scene, prefab or asset
with Undo and stays in memory until the user presses Save: an unsaved marker lists what changed,
prefab instances get Unity's overrides with Apply to Prefab and Revert, and closing the panel asks to
save or discard. Discard also moves assets the Tuner created, like a new clip, to the Trash. In Play
Mode scene values are lost when play stops, so the Copy prompt button copies those changes
(before -> after) for the agent and Reset puts them back, while asset edits are saved right away. A prefab Tuner (`prefabs`) opens prefab assets on their own, like Unity's prefab mode,
and Save writes them. The
scene view also draws sprites, tilemaps and uGUI elements in a flat 2D view. Play Mode `states`
(a few frames of an attack, a spawned wave) each name their own objects and setup steps (`animate`,
`call`, `set`, `pause`), and the copied prompt groups the changes by state. `merge` adds to an
existing view, and the reply lists the other views.

**Animation timeline.** Every Tuner has a timeline under its scene view for the clips of the
selected object: an Animator with a controller (override controllers too) or a legacy Animation,
on the object or a parent. Edits go into the `.anim` clips, saved with Save in Edit
Mode and right away in Play Mode, and look the same in Unity's Animation window. `tuner.open({ animator: { path, clip } })` opens it on an
object. Agents edit the same clips through `unity.exec` with `SaturaClips`, a C# helper in the
engine: `List`, `Get`, `Describe`, `Create` (a new clip, attached the way Unity attaches one, or an
Animator with a new controller for an object with none), `SetKeys`, `RemoveKeys`, `RemoveProperty`, `SetEvents`,
`AddEvent`, `Settings` and `Delete`, with `Muscle` for humanoid curves. Imported clips are read-only.

**Scratchpads.** A scratchpad is an empty Unity project with the main project's Unity version,
packages and ProjectSettings, stored at `.sspace/scratchpads/<id>`. The app manages the pool: it runs
each scratchpad's editor and streams the selected one into the Scratchpads panel. `scratchpad.*`
(`list`, `create`, `start`, `stop`, `restart`, `rename` or `remove`, which deletes the scratchpad's
Library, Temp, Logs and obj and moves the rest to the Trash) passes the command to
the app over its control socket, which the app advertises in `.sspace/.mcp_scratchpad_host.json`. If
the app isn't running, the call fails with a clear message. `create`, `start`, `restart` and `get`
(a name, id or folder, without starting it; the app answers it) return the scratchpad: its `id`,
`name`, `path` and the `report` the command printed, plus every `unity` call bound to its editor,
including its own `players`, `addPlayer` and `removePlayer`. `unity.at(path)` gives the same calls.
`scratchpad.import` and `scratchpad.export` copy assets into a scratchpad or exports them back,
together with their `.meta` files and everything they reference by GUID. Export never replaces a
file unless you pass `overwrite`.

**Screenshots.** `unity.screenshot()` renders the scene from 1 to 16 camera poses
(`{ camera, lookAt }`), in Edit or Play Mode. One point gives one image. Several points give
a single grid image, filled row by row in the order given. The PNG comes back inline in the tool
result and nothing stays on disk unless you pass `{ save: true }` or a path; then it is written (by
default under `.sspace/screenshots/`) and the call returns the path. An editor still on an older
engine refuses grids with a clear message until it relaunches.

**Video.** `video.*` records what the Unity panel shows. `start` records, `stop` pauses, and
the next `start` continues the same video with no gap. `finish` joins the segments into one `.mp4`
(default under `.sspace/videos/`), and `clear` discards them; `record(fn)` does all of it around a
function. Video is muted unless the first `start` passes `audio: true`. Size defaults to 1920x1080, and the player's stream
stays locked to it until `finish` or `clear`, with a badge on the panel. It needs the
Satura Space app: encoding runs there on the hardware H.264 encoder. `await video.open(path)`
shows the result to the user.

**Handles.** The engine's `[SaturaHandle("what it does")]` marks a public static method an agent may
call to set up a moment of the game, act, or read state. `handles.list()` lists them and
`handles.call(name, ...args)` runs one through `SaturaHandles.Call`, sent to the editor as a ready
operation with no C# to compile, and returns the
value and the log lines written during the call, or throws `HandleError` with the error and stack. A
handle that returns `IEnumerator` runs as a coroutine: the server polls `SaturaHandles.Result(id)`
until it finishes (`{ wait: false }` returns the run id at once). With `{ player: 'all' }` it uses
`SaturaHandles.StartAt(SameMoment(seconds), name)` so every multiplayer player starts at the same
wall-clock moment; `SameMoment` is an exec template helper whose base time is shared by all players
of one call.

**Reports.** An agent writes a report as a React component, `.sspace/reports/<name>/report.tsx`,
built from the app's report kit (`@satura/report`: Report, Summary, Checks, Video, Log, Compare and
more) plus its own JSX. `report.open(path)` sends the path to the app, which compiles and type-checks it
against the kit's types and returns errors as `path:line:column` messages. A clean report opens in a
panel next to the agent's terminal, rendered in a sandboxed frame with the app's own components and
theme that reaches the app only through a checked bridge, and a render error comes back with its
stack mapped to report.tsx lines. The panel reloads when the
file is saved. Every video the user opens
in the app plays in the kit's frame-by-frame player.

**Env files.** `env.*` checks and manages the files the user marked "never commit" in
Satura Space, with the same rules as the app's Env Changes. `list` shows each env file and its
state, and `check` says whether `git add` is safe for the given paths. `stage` stages only the
agent's new lines in an env file: the user's env edits stay out of the index, and the working file
doesn't change. `diff` shows what `stage` would add. `add`, `remove` and `keep` edit the list and
its snapshots in `.sspace/never-commit.json`, in the same format the app writes. A file gets a
snapshot only when it is tracked text that git merges as text (the `.gitattributes` `merge`, `text`
and `binary` attributes decide); any other env file stays out of commits as a whole.

**The app.** The script also gets `page`, the caller's own window, with a Playwright-style API: locators, clicks that
wait for their element, mouse and keyboard. Input goes in over Chromium's DevTools protocol, so it
reaches the window without moving the user's cursor or taking focus. The user sees a labeled agent
cursor (Drift) only when the call passes `drift: true`, and the script waits whenever they use
that window. `agents.*` runs other agents in Satura
Space tabs. `spawn` opens an agent tab with a task, as a new tab in the caller's group or as a split
to its right or below it. `send` types a follow-up message into that tab. The child answers with
`report`, and the app types the report into the caller's terminal. `close` closes the child and any
agents it started. `status` lists the project's agent terminals, what each one is doing and which
agent started which. The app checks every call: an agent can message and close only the agents it
started, can report only to the agent that started it, and can have at most 4 running at once.
`logs.*` reads the app's main log and the window's console, and `shot()` sends screenshots back as
images. `page.evaluate` can call the app's own `window.api`. The script has no `require`, `import`,
`process` or file access. It runs in its own worker with a time limit (300 seconds by default, an
hour at most) and stops
when the MCP call is cancelled. The app identifies the calling terminal by `SATURA_PANE_KEY`, which
it sets in every terminal and forwards to this server through the Claude Code, Cursor and Codex MCP
configs. Calls go to the app's agent-hook server, whose port and token are in
`~/.satura/agent-hooks/endpoint`.

**Two modes.** The server is multi-project by default. `SATURA_MCP_PROJECT_ROOT` locks it to one
project for standalone editor use. Both modes register the same tool, and both need the app running. The orchestrator must not set
it.

The server refuses every tool once the installed engine/app markers move ahead of its own version.

## Checking a change

There is no automated test suite. Check a change on a dev instance
([`apps/orchestrator/DEV-INSTANCE.md`](../../apps/orchestrator/DEV-INSTANCE.md)):
`node apps/orchestrator/scripts/satura.mjs --instance <name> exec '<js>'` runs `unity.*`, `handles.*`
and `video.*` through this package's `.venv`, the way an agent's MCP does. Call `handle unity.ready`
first and read `value` and `logs` after every call. The editor keeps the MCP it launched with, so
restart the dev instance and reopen the project after editing this package. CI only installs
`requirements.txt` and byte-compiles `unity_mcp` on Python 3.12.

Freezing the binary is `apps/orchestrator/scripts/build-mcp.mjs` (digest-gated, run by pack).
