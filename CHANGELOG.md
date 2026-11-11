# Changelog

## 3.2.0 — 2026-11-12

- **Project plugins** — an agent writes a plugin straight into the project's `.sspace/plugins/<name>/`, and the app picks it up while it runs: a panel with the dashboard kit, functions the agent calls as `plugins['<name>'].fn()` from `satura_exec`, and notes for agents. Saving a file reloads it. Panels and functions run in the same sandboxes as dashboard widgets and agent scripts, never as Node in the app, and `.sspace/` stays out of git.
- **Plugins menu** — New session → Plugins lists Built-in plugins (Free Assets) and This project's plugins, and New plugin… starts your agent on a plugin you describe.
- **Agents** — `plugins.list()`, `plugins.open(name)` and `plugins.read(name)` show a plugin's panel and its compile errors, so an agent can write and fix a plugin on its own. The agent guide has a new plugins page.

## 3.1.1 — 2026-11-12

- **Dropdowns open in place** — a dropdown inside a panel, like the source filter in Free Assets, opens right under its button instead of somewhere else in the window.

## 3.1.0 — 2026-11-12

- **Plugins** — a plugin is one folder in `plugins/` and ships inside the release: app handles, functions the agent calls from `satura_exec`, a panel in the New session menu, C# that goes into the project's editor, and a page of the agent guide. How to write one is in `CONTRIBUTING.md`.
- **Free Assets** — the first plugin. Search CC0 models, materials and HDRIs from Poly Haven and ambientCG in a panel, or let the agent call `assets.search` and `assets.import`. Each import gets materials built for the project's render pipeline (URP or Built-in), a prefab that sits on the ground, an optional skybox, and a credit line in `Assets/ThirdParty/CREDITS.md`.

## 3.0.5 — 2026-11-11

- **Open any folder from the phone** — Satura Remote browses and opens folders anywhere on the desktop, the same as the desktop app, not only inside the home folder and on external drives. The folder list has a Computer entry for the top of the disk.
- **Multi-line phone composer** — the phone composer writes multi-line text, and Claude's input on the desktop grows with it.
- **Phone stream stays smooth** — Scene and Game no longer drop to 5 fps on the phone after the desktop app has been running for hours: the Mac-side encoder kept two process clocks that drift apart. A still picture now goes out at about 35 fps instead of 5, and a frame rate you set lower yourself is kept.

## 3.0.4 — 2026-11-10

- **Phone terminal input** — paste fills the composer, multi-line sends use bracketed paste, and while a menu is open the phone shows arrow keys and Enter instead of option chips.
- **Tuner** — drag to resize the staging panel; on Windows the editor stays fast while a Tuner is open.
- **Reports** — staging runs report their length in game seconds, and the player bar keeps the frame counter and timecode whole in narrow players.
- **Handles** — `ui.mouse` drives the window with real mouse and keyboard input.
- 3.0.3 was never published; its changes are in 3.0.4.

## 3.0.2 — 2026-11-10

- **Windows terminals** — `conpty.dll` ships with the rebuilt node-pty, so terminals start on Windows.
- **Phone tabs** — tabs light up on the open phone instead of sending notifications.
- **Fixes** — hot reload reads the `SATURA_SPACE` define from `Assets/csc.rsp`, the frame rate readout is measured under the new cap, a scenario that fails on its first frame keeps its video, Drift brings the Unity Player tab forward before pointing at it, and a project that is not a git repository says so plainly.
- **Handles** — `remote.controls` and `remote.gameInput` ship in release builds.
- **Security** — minimatch is overridden to 11.0.1 (GHSA-g3hv-75wg-m249).

## 3.0.1 — 2026-11-09

- **Phone app check** — the desktop checks the phone app it serves against its GitHub build attestation, so the phone runs exactly what CI built from public `main`.

## 3.0.0 — 2026-11-09

- First open-source release.
