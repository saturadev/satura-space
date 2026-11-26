# Changelog

## 3.5.0 — 2026-11-26

- **Monetization and Publishing references** — two built-in plugins with no code, each a page in the agent guide plus HTML pages for you: how web games earn, the ad rules every portal shares, how to set up a Unity web build, and how each platform takes builds (CLI, API, MCP or web console). Nothing that changes is copied into them: limits, revenue shares, SDK versions and commands link to the platform's own pages, and the agent reads those live before it acts. Ask your agent to show you a page.
- **Trends** — a built-in reference for finding what is rising on TikTok and Instagram. Your agent sets up its own Playwright browser in `~/.satura-trends`, separate from your Chrome. You sign in to your own account there, and it reads your feed, searches, hashtags and TikTok's public trend lists at a person's pace without liking, following or commenting. You get five to ten formats with numbers, example links and a game idea for each, and the files stay in the project's `.sspace/trends/`.
- **Plugins** — a plugin's `pages/` folder lands next to its page in the agent guide, so a plugin can be a reference with no code at all.

## 3.4.0 — 2026-11-26

- **Playable ads from a Unity game** — the built-in `playables` plugin turns a Unity scene into a playable ad: one HTML file with the real game logic and no Unity runtime inside. The editor exports the scene, prefabs, animations, sprites, meshes, materials and audio; a small JS runtime re-implements the part of the UnityEngine API games use (2D, uGUI, Animator, coroutines, and on demand a WebGL 3D renderer, 3D physics and Web Audio); the agent writes each gameplay script once more in JS with the same names, and the plugin packs it. `playables.init`, `scan`, `export`, `pack`, `size`, `verify`, `preview` and `networks` in `satura_exec`, each also an app handle, and a page in the agent guide that walks an agent through any game.
- **Checked against Unity** — `playables.verify` plays the same seeded input in the HTML and in the project's editor in play mode on a fixed 60 fps step and compares the game state after every step. A match-3 from GitHub matches Unity in 340 of 340 states, a 3D helix jump with rigidbody physics in 162 of 162.
- **Fits the ad budget** — sprite atlases and textures go to WebP at a chosen scale and quality, meshes are reduced with quadric edge collapse and quantized, audio is trimmed and re-encoded to Opus, and `playables.size` shows where every byte goes.
- **Every big ad network** — `playables.networks` writes a ready variant for AppLovin, Unity Ads, ironSource, Mintegral, Google Ads, Meta and TikTok, each with that network's CTA call, lifecycle, container and size limit, and checks each one in a hidden page under a mock of the network API.
- **Plugins** — main-process plugins can open hidden offscreen pages, zip files, and read their own files live from the repo in dev builds.

## 3.3.0 — 2026-11-22

- **A game from a video** — The start screen has a Copy tab: paste a link, pick Claude Code's model and effort, and that's all. Paste a link to a short video (TikTok, Instagram Reels, YouTube Shorts, X, or any page yt-dlp reads) and Satura Space downloads it, cuts it into frames, creates a project on the newest Unity you have installed and starts your agent on a small game that plays like the clip, with its own names, characters and art. The agent first looks on GitHub for the best open-source solutions to the clip's core mechanic, adapts only permissively licensed ones and credits them. The agent films the gameplay and renders a Remotion video with the clip next to the game, saved as `ClipToGame/clip-vs-game.mp4`. A bad, private or removed link shows the reason in the window and no project is created.
- **Clip to game plugin** — the built-in `clipgame` plugin does the download, the frames and the render, and adds `clipgame.fetch(url)`, `clipgame.render()` and `clipgame.info()` to `satura_exec` plus a page in the agent guide. In a project you already have, give your agent a link and `clipgame.fetch` brings the clip in, and the game goes into its own `Assets/ClipGame/<name>/` folder. The first use downloads yt-dlp and installs the Remotion tools once per computer; rendering needs Node.js 18 or newer.

## 3.2.2 — 2026-11-22

- **Hot reload works with the live game** — a patched method now reads and writes the running game's static fields and uses its types, so `GetComponent<T>()`, `typeof`, `is` and `as` find live objects instead of missing them. Before, patched code worked on a separate copy of every class, and statics restarted from their defaults. Fields, methods and types added in the edit still run on that copy until you stop and refresh, and the console names each of them once.

## 3.2.1 — 2026-11-12

- **Plugins on the phone** — Satura Remote opens plugin panels, built-in and the project's own, from New session → Plugins. A project plugin reloads on the phone when its files change.
- **Free Assets on the phone** — a phone layout with search, filter chips, a two-column grid and a full-screen details view. Importing shows each step with a progress bar, and a failed import shows the error with Try again.
- **Fixes** — a Free Assets download that stops sending data fails after 30 seconds instead of hanging.

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
