# Dev instances

A dev instance is a dev build of the app that runs next to your everyday dev app (`pnpm dev`) and
shares nothing with it. Each one has a name and its own userData, ports and Unity project, so
several can run at once. The examples use `alt`; any other name works.

## Start

From `apps/orchestrator` on macOS:

```bash
bash scripts/macos/dev-instance.sh alt
```

`corepack pnpm@10.34.9 dev:instance alt` runs the launcher behind it (`scripts/dev-instance.mjs`)
directly, on any platform.

Detached, so it outlives the terminal that started it:

```bash
python3 -c "import os,subprocess; d=os.path.expanduser('~/Library/Application Support/satura-space-dev-alt'); os.makedirs(d,exist_ok=True); subprocess.Popen(['bash','scripts/macos/dev-instance.sh','alt'], stdin=subprocess.DEVNULL, stdout=open(os.path.join(d,'dev-instance.log'),'w'), stderr=subprocess.STDOUT, start_new_session=True)"
```

An instance runs in the background by default (`SATURA_BACKGROUND=1`, which `scripts/dev-instance.mjs` sets): its windows stay hidden, it has no Dock icon, and neither it nor its Unity (`SATURA_WINHOOK_NO_ACTIVATE=1`) takes focus, so it doesn't disturb whoever works on the Mac. `SATURA_BACKGROUND=0` shows the window.

Startup is good when the log shows `[dev-instance] "alt" userData=…satura-space-dev-alt` and
`[agent-hooks] dev instance "alt": endpoint …satura-space-dev-alt/agent-hooks/endpoint`.

For Satura Remote, `SATURA_REMOTE_HOST_NAME` sets the name an instance shows phones in place of the
computer name, so a phone paired with two instances on one desktop can tell them apart. `SATURA_REMOTE_HOST_KIND`
(`os:form[:model]`, e.g. `windows:laptop` or `macos:all-in-one:iMac`; os `macos`, `windows`, `linux` or
`other`, form `laptop`, `all-in-one`, `compact`, `tower`, `desktop` or `unknown`) sets the kind of
computer it tells phones, which picks the picture they show; `remote.status` returns it as `kind`.

An instance connects to the hosted relay (`wss://relay.saturaspace.com/ws`) once Remote is on.
`SATURA_RELAY_URL=ws://127.0.0.1:<port>/ws` points it at a local relay instead
([`packages/companion-app/README.md`](../../packages/companion-app/README.md)); `remote.status` then
shows the relay, whether it registered, and `phoneRelay`, the phone site the relay named in its
welcome (`SATURA_RELAY_PUBLIC_WEB`), which pairing links open. `remote.phoneApp` runs the phone app
tripwire now; in a dev build `SATURA_PHONE_APP_WEB` points it at a local server that serves a
`phone-app.json` and the files it lists, and `SATURA_PHONE_APP_ATTESTATIONS` replaces
`https://api.github.com/repos/saturadev/satura-space/attestations`, the base it asks for
`/sha256:<hex>` of that `phone-app.json`.

The test project is `~/projects/_satura-test-alt` unless `SATURA_TEST_PROJECT` points elsewhere
(`scripts/test-project.mjs`). Handles that write files only run on that project.

## Drive it

```bash
node scripts/satura.mjs --instance alt handles
node scripts/satura.mjs --instance alt handle unity.ready
node scripts/satura.mjs --instance alt exec '<js>'
```

Call `unity.ready` first and read `value` and `logs` after every call.

## Checking the app's own code

Every app handle is also `app.handle(name, params)` inside an `exec` script. It returns
`{ status, value, error, logs }`, where `logs` are the app log lines that call caused, so one script
can run handles across several areas, compare the values in JS and return one result. A handle
checks nothing itself: it does the hard part and returns data, and the script does the asserting.

| Handle | Reaches |
|---|---|
| `fn.list`, `fn.call` | any export of `src/main/**` and `src/shared/**` with JSON args: parsers (`unity/unity-process-parse`), `@shared/pane-plan`, drift pose and anchor math (`satura-exec/page/drift-pose`). A module that touches the disk runs only with scratch paths in its args (`unity/editor-install` Hub sqlite, `unity/unity-runtime` staleness, `safe-fs`) |
| `fn.window.list`, `fn.window.call` | pure renderer modules: tuner curves, rotation, rect, scene gizmo |
| `scratch.dir` | files, symlinks and sqlite databases in a temp dir the other handles work in |
| `paths.guard` | every path guard (safe-fs, open roots, fs IPC, Git view, dashboard `useFile`, reports, phone policy) on paths and symlinks |
| `hooks.install` | the Claude, Cursor, Grok, Kimi hook installers and `~/.codex/config.toml`, against a temp HOME |
| `gitQueue.run` | the git queue's priority order, timeouts, SIGKILL and stuck-output release, with a fake git |
| `fake.start`, `fake.hits` | fake HTTP upstreams (relay auth, TURN, Cloudflare) and a fake app control socket (for the MCP) |
| `relay.start`, `relay.http`, `relay.ws`, `relay.state` | a local relay child process: pairing, auth gate, rate limits, socket caps, admin, usage flush, ICE, malformed frames and paths |
| `mcp.call` | one `packages/mcp/unity_mcp` function in a scratch project: lock holders, enqueue, socket errors, `.sspace` gitignore |
| `unity.kill` | SIGKILL of the test project's editor, for crash recovery such as SaturaPrefGuard |
| `scratch.list`, `scratch.close` | what is still open |

Dirs, fakes, relays and sockets opened in a script close when it ends; pass `keep: true` to keep one
for later `handle` calls, then `scratch.close`. These handles run only from `exec` and the CLI, never
from a report action or the phone. Paths they touch must be inside the temp jail
(`$TMPDIR/satura-handles`).

```js
const calls = []
const h = async (name, params, opts) => {
  const r = await app.handle(name, params, opts)
  calls.push({ name, status: r.status, logs: r.logs })
  if (r.status !== 'done') throw new Error(`${name}: ${r.error}`)
  return r.value
}
const dir = await h('scratch.dir', { files: { 'p/a.txt': 'in', 'outside/s.txt': 'out' }, links: { 'p/out': '../outside' } })
const guards = await h('paths.guard', { root: dir.root + '/p', paths: ['a.txt', 'out/s.txt'], guards: ['gitScm.write', 'phone.fs:writeFile'] })
const fake = await h('fake.start', { routes: [{ path: '/plan', status: 401 }] })
await h('relay.start', { env: { SATURA_RELAY_AUTH_URL: fake.url + '/plan' } })
const junk = await h('relay.ws', { send: ['not json'] })
const phone = await h('relay.ws', { hello: { t: 'hello', role: 'phone', hostId: 'abcdef123456', ticket: 'v1.e30.c2ln' } })
const hits = await h('fake.hits', {})
const procs = await h('fn.call', { module: 'unity-process-parse', fn: 'parseWinProcLines', args: ['12\tC:\\U\\Unity.exe -projectPath C:\\P\n0\tbad\n'] })
const checks = {
  insideWritable: guards.paths[0].guards['gitScm.write'].allow,
  linkOutRefused: !guards.paths[1].guards['gitScm.write'].allow && !guards.paths[1].guards['phone.fs:writeFile'].allow,
  junkClosed: junk.closed?.code === 4000,
  signinRequired: phone.received[0]?.code === 'signin',
  ticketSentAsBearer: hits.hits[0]?.headers.authorization === 'Bearer v1.e30.c2ln',
  winParsed: procs.value.length === 1 && procs.value[0].pid === 12
}
return { ok: Object.values(checks).every(Boolean), checks, calls: calls.map((c) => [c.name, c.status, c.logs.length]) }
```

## Stop

- Cmd+Q in the instance window.
- From a shell: `kill -TERM <pid>` of `bash scripts/macos/dev-instance.sh alt`. The script stops its
  own Electron, which quits Unity cleanly first. Wait for it to exit before killing anything by
  hand: a killed Unity leaves a scene backup behind.
- The terminal daemon outlives restarts on purpose. Full cleanup:
  `pkill -f 'satura-space-dev-alt/daemon'`.

Kill by pid or by the instance name. `pkill -f electron-vite` or `osascript … quit app` also hit
your other dev app.

## What is separate

|             | dev app (`pnpm dev`) | dev instance `<name>`         |
|-------------|----------------------|-------------------------------|
| userData    | `satura-space-dev`   | `satura-space-dev-<name>`     |
| renderer    | :5273                | :5373 + slot                  |
| Unity ports | 10210+               | 12210 + 1000 × slot           |
| hook server | `~/.satura`          | own, in its userData          |

The slot is fixed for `alt` (0), `t2d` (1), `t3d` (2) and `anim` (3). Any other name hashes to a
slot from 4 to 31, so two unusual names can collide; the launcher's first line prints the renderer
port and the Unity port base.

`~/.satura/agent-hooks/endpoint` and `~/.claude/settings.json` belong to the main dev app, so an
instance runs its own hook server, writes its endpoint only into its userData and installs no agent
hooks. Its terminals get that endpoint in `SATURA_AGENT_HOOKS_ENDPOINT`, so `satura_exec` from an
instance terminal reaches that instance. It never writes `~/.codex/config.toml`.

An instance refuses Unity and engine work on any project that a running Satura Space or dev app has
open or in its recent folders, or one with another app's Unity open on it (log line
`[dev-instance] … won't touch …`).

## Native

- Windows Unity clones run as GUI editors with windows hidden by `unityhook.dll`; never
  `-noMainWindow` there, it has no GameView and crashes the render thread. macOS uses
  `winhook.dylib` + `-noMainWindow`.
- Native build artifacts (`*.obj/.lib/.exp`) are gitignored.
- Windows relaunch after engine or MCP edits: `cd scripts/windows; ./launch.ps1`.
