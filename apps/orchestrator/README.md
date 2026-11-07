# Satura Space (desktop app)

Electron + electron-vite + React 19 + Zustand + Tailwind v4 + TypeScript. Launches Unity editors,
streams them into panels, and runs agent terminals beside them.

```bash
nvm use                          # Node 24
corepack pnpm@10.34.9 install    # postinstall rebuilds node-pty for Electron and builds native/shared-surface
corepack pnpm@10.34.9 dev
corepack pnpm@10.34.9 typecheck  # main + preload + renderer
```

A plain `pnpm` must be 10.x here too (pnpm-10 workspace format; packaging calls whatever `pnpm` is
on PATH). Packaging, signing and the bundled
binaries: [`PACKAGING.md`](PACKAGING.md). There are no automated test suites: verify
changes on a dev instance with app handles, [`DEV-INSTANCE.md`](DEV-INSTANCE.md).

```
src/
├── main/       Electron main: windows, IPC, Unity lifecycle, terminals, git, Satura Remote host
├── preload/    contextBridge → window.api
├── shared/     framework-free types + the PreloadApi contract
└── renderer/   React shell: zustand slices + components
```
