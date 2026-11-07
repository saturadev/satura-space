# AGENTS.md

Agent brief for the **Satura Space** monorepo: run coding agents on a Unity project and watch and play
what they built, live, in streamed headless editors. Layout and setup: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Rules

- **No code comments.** Any language. Rationale goes in the PR description or the commit message.
- **Versioning is lockstep.** The app and the engine carry the same version. The app embeds the
  engine from its own bundle, so a project never installs anything from GitHub.
- **Validate with logs, not screenshots.** Screenshots only for the visual half, never as proof that a
  feature works.
- **No test suites; handles are the test surface.** Verify every change on a dev instance with app
  handles, never by opening a Unity window on the developer's machine. Start one
  ([`apps/orchestrator/DEV-INSTANCE.md`](apps/orchestrator/DEV-INSTANCE.md)), drive it with
  `node apps/orchestrator/scripts/satura.mjs --instance <name> handles|handle|exec`, call
  `handle unity.ready` first, and read `value` and `logs` after every call. Missing handle: add one in
  `src/main/handles` or `src/renderer/src/handles`. Don't add test files or test frameworks. Headless
  `-quit` batch runs are fine.
- **Never sit idle waiting.** Every wait gets a deadline matched to the event. When it passes, check
  the real state and act: kill, shorten or split.
- **Close what you launched.** Kill the electron-vite supervisor before Electron, and target processes
  with `pgrep -xf <exact binary>`; matching on arguments hits the wrapper shell. Never touch a dev app
  or dev instance you didn't start.
- **No formatter.** The source is not prettier-formatted; match the surrounding style by hand.
- **The editor runs the engine and MCP it launched with.** Edits to `packages/saturaspace-engine` or
  `packages/mcp` need a dev app relaunch and project reopen. Keep this out of tool descriptions.

## Git

- **Commits are one short `type(scope): summary` line,** no body. One feature is one to three commits.
- Native helpers for macOS (`winhook.dylib`, `SaturaSharedSurface.bundle`) are committed; rebuild them
  with the `build.sh` next to their source after changing it.
