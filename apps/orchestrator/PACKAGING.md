# Packaging the orchestrator

electron-vite builds sources into `out/`; electron-builder packages them into `dist/`. Targets are
macOS arm64 (dmg + zip) and Windows x64 (NSIS), both auto-updating from this repo's GitHub
Releases. Config: [`electron-builder.yml`](./electron-builder.yml).

## Build

```sh
nvm use 24
corepack pnpm@10.34.9 install    # postinstall rebuilds node-pty and builds native/shared-surface
npm run pack                     # unpacked .app/dir, no dmg or installer
npm run dist                     # full artifacts
```

Both build the app and the phone app (`vite.remote.config.ts`) first, then freeze the MCP server,
which needs Python 3 (it creates `packages/mcp/.venv` and installs PyInstaller there).

`pnpm --version` must report **10.x** in this directory: the workspace file is pnpm-10 format and
electron-builder shells out to whatever `pnpm` is on PATH, failing with `packages field missing or
empty` under pnpm 9.

On a dev Mac with a signing identity in the keychain, electron-builder signs every file with
`--timestamp` and a `--dir` pack crawls. Force a genuinely local pack with
`CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack`.

## Bundled binaries

| What | Built by | Notes |
|---|---|---|
| MCP binary (`resources/mcp/`) | `scripts/build-mcp.mjs`, run by pack | gitignored; digest-gated so a pack can never ship an MCP stale against the engine |
| winhook (`winhook.dylib` / `unityhook.dll`) | `resources/winhook/build.sh`, `build-win.ps1` | the dylib is committed, the Windows DLL is built on Windows |
| shared-surface addon (`native/shared-surface`) | `npm run build:native`, run by postinstall | IOSurface on macOS, D3D11 on Windows; needs the Xcode or VS C++ toolset |
| Unity shared-surface plugin (`SaturaSharedSurface.bundle` / `.dll`) | `packages/saturaspace-engine/.native/sharedsurface/build.sh`, `build-win.ps1` | the bundle is committed, the Windows DLL is built on Windows |
| engine package | none | copied from `packages/saturaspace-engine` |
| plugin Unity code and guides (`resources/plugins/`) | none | `plugin.json`, `agent.md` and `unity/` of each `plugins/<name>`; the app copies `unity/` into the embedded engine as `Plugins/<name>/`. Plugin main and window code is in the app bundle |

**Anything `fork()`ed with `ELECTRON_RUN_AS_NODE` bypasses asar**, so its entry and every module it
requires must be in `asarUnpack`: `out/main/daemon-entry.js`, `out/main/chunks/**`,
`node_modules/@xterm/**`, `node_modules/node-pty/**`, `@vscode/ripgrep/bin`, `native/shared-surface`.
Miss one and the terminal daemon exits code 1 with blank terminals **in packaged builds only** —
that shipped once. Add a daemon dependency, unpack it too, and smoke-test terminals in a packed
build. node-pty additionally carries a patch (`patches/node-pty@1.1.0.patch`) whose macOS half
guards its `app.asar` → `app.asar.unpacked` rewrite against double-application.

## Signing

Release builds run in CI: pushing a `v*` tag runs
[`.github/workflows/build.yml`](../../.github/workflows/build.yml), which drafts a GitHub Release,
builds and signs both platforms with the secrets of the `signing` environment, and uploads the
artifacts and update feeds (`latest-mac.yml`, `latest.yml`) to the draft. The app sees the update
once the draft is published. A tag build refuses to publish unsigned. Contributors don't need any
of this; local packs build unsigned.

macOS is signed and notarized on every release build. `mac.notarize` stays **false** on purpose:
the `afterSign` hook `build/notarize.cjs` notarizes and staples instead. It uses an App Store
Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`), else an Apple ID
(`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), else the `satura-notary` notarytool
keychain profile. The build therefore logs both "skipped macOS notarization" and
`[notarize] accepted + stapled` — only the second matters. `SKIP_NOTARIZE=1` bypasses it for a
local pack. `xcrun stapler validate` on the **dmg** always says no ticket: the hook staples the
`.app` before the dmg wraps it, so validate the app instead.

The app binary gets only the V8 JIT entitlements (`build/entitlements.mac.plist`), so it ignores
`DYLD_*` variables and loads only Apple- or team-signed code. The winhook still reaches Unity: the
app sets `DYLD_INSERT_LIBRARIES` in the editor's spawn environment, and Unity's own signature decides.
Helpers and nested binaries keep `build/entitlements.mac.inherit.plist`, because the onefile
PyInstaller MCP loads libraries it unpacks at runtime.

Fuses (`electronFuses`): `NODE_OPTIONS` and `--inspect` are ignored, and the app loads only its
`app.asar`, checked against the hash in `Info.plist`. `RunAsNode` stays on because the terminal
daemon runs as `ELECTRON_RUN_AS_NODE` and has to outlive the app.

Windows signing runs through `build/sign-win.cjs` when `SATURA_WIN_SIGN=1`, which also needs
`SATURA_WIN_PUBLISHER` (the certificate subject). With `CERTUM_OTP` set it signs with `ssign`, as CI
does; otherwise it runs `signtool` against the certificate in the Windows store (`SATURA_SIGNTOOL`
points at a specific `signtool.exe`).

## Dev and release side by side

`src/main/dev-isolation.ts` keeps them fully separate: app name `Satura Space Dev`, userData
`satura-space-dev`, its own pty-daemon socket, and disjoint Unity port blocks (`10210…`/`10810…` in
dev versus `9210…`/`9810…`). The single-instance lock is keyed on userData, so one of each can run
at once.

## Troubleshooting

- **MCP tools work in dev but fail packaged** — a stale MCP binary next to a fresh engine. The
  digest guard prevents it now; rebuild with `node scripts/build-mcp.mjs --force`.
- **Windows `EPERM … rename 'dist\win-unpacked.tmp'`** — AV, the search indexer, cloud sync, or a
  running dev `electron.exe` holds the extracted tree. Kill the dev app; if it persists, pre-extract
  Electron and pass `--config.electronDist=.electron-dist`.
- **`ENOTEMPTY … rmdir dist/mac-arm64`** — a `.DS_Store` Finder wrote by previewing the folder.
  electron-builder clears its output dir with `rmdir`, which needs it empty. Don't browse `dist/`
  during a build.
