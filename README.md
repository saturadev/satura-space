# Satura Space

[![CI](https://github.com/saturadev/satura-space/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/saturadev/satura-space/actions/workflows/ci.yml)
[![Build](https://github.com/saturadev/satura-space/actions/workflows/build.yml/badge.svg)](https://github.com/saturadev/satura-space/actions/workflows/build.yml)
[![Phone app](https://github.com/saturadev/satura-space/actions/workflows/phone-site.yml/badge.svg?branch=main)](https://github.com/saturadev/satura-space/actions/workflows/phone-site.yml)
[![Release](https://img.shields.io/github/v/release/saturadev/satura-space?label=release)](https://github.com/saturadev/satura-space/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/saturadev/satura-space/total)](https://github.com/saturadev/satura-space/releases)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows-5e6ad2)](https://github.com/saturadev/satura-space/releases/latest)
[![License](https://img.shields.io/github/license/saturadev/satura-space)](LICENSE)

**Your AI game studio. On real Unity.**

Claude Code, Codex, Cursor and other coding agents build your game in Unity. You play it live while
they work, tune the feel in Unity's real Inspector, and ship a normal Unity project. It's free and open source.

![Satura Space: four players streaming, a Tuner on one runner, four agents working in scratchpads](.github/media/hero-app.webp)

- **Idea in, game out.** Give your agent a sentence, a design doc or a link to a game clip. It builds
  the game in a hidden Unity editor of its own, and several agents build at once.
- **Play it while it's built.** The game streams into the app beside the agents' terminals, so you
  play every change without building a player or revealing the editor.
- **Tune the feel by hand.** When a value needs your eye, the agent hands you Unity's real Inspector
  on just that, and your edits go back to it.
- **Ship it, or make it earn.** It's your Unity project: build it for Steam, mobile or web. The
  playables plugin turns a scene into a one-file playable ad for seven ad networks.
- **Your agents, your AI plan.** Any CLI agent on your PATH. No API key, no credits, no token markup.

## Made with Satura Space

I pasted eight TikTok game clips into Satura Space. For each one a Claude agent watched the clip,
built an original Unity game that plays like it, playtested it with a bot and published the repo.
Prices are what each game cost at API rates. All eight play in the browser at
[saturaspace.com/games](https://saturaspace.com/games).

<table width="100%">
<tr>
<td width="25%" valign="top"><a href="https://saturaspace.com/play/throw/"><img src="https://saturaspace.com/media/game-sprout-sling.jpg" width="100%" alt="Sprout Sling"></a><br><b>Sprout Sling</b> · $7.11<br><a href="https://saturaspace.com/play/throw/">Play</a> · <a href="https://github.com/saturadev/sprout-sling">Source</a></td>
<td width="25%" valign="top"><a href="https://saturaspace.com/play/ballrun/"><img src="https://saturaspace.com/media/game-tumble-lane.jpg" width="100%" alt="Tumble Lane"></a><br><b>Tumble Lane</b> · $10.85<br><a href="https://saturaspace.com/play/ballrun/">Play</a> · <a href="https://github.com/saturadev/tumble-lane">Source</a></td>
<td width="25%" valign="top"><a href="https://saturaspace.com/play/merge/"><img src="https://saturaspace.com/media/game-spud-bowl.jpg" width="100%" alt="Spud Bowl"></a><br><b>Spud Bowl</b> · $8.19<br><a href="https://saturaspace.com/play/merge/">Play</a> · <a href="https://github.com/saturadev/spud-bowl">Source</a></td>
<td width="25%" valign="top"><a href="https://saturaspace.com/play/bear/"><img src="https://saturaspace.com/media/game-grizzle-valley.jpg" width="100%" alt="Grizzle Valley"></a><br><b>Grizzle Valley</b> · $4.89<br><a href="https://saturaspace.com/play/bear/">Play</a> · <a href="https://github.com/saturadev/grizzle-valley">Source</a></td>
</tr>
<tr>
<td width="25%" valign="top"><a href="https://saturaspace.com/play/brawl/"><img src="https://saturaspace.com/media/game-flopyard.jpg" width="100%" alt="Flopyard"></a><br><b>Flopyard</b> · $5.49<br><a href="https://saturaspace.com/play/brawl/">Play</a> · <a href="https://github.com/saturadev/flopyard">Source</a></td>
<td width="25%" valign="top"><a href="https://saturaspace.com/play/spear/"><img src="https://saturaspace.com/media/game-spear-drop.jpg" width="100%" alt="Spear Drop"></a><br><b>Spear Drop</b> · $6.81<br><a href="https://saturaspace.com/play/spear/">Play</a> · <a href="https://github.com/saturadev/spear-drop">Source</a></td>
<td width="25%" valign="top"><a href="https://saturaspace.com/play/mudbike/"><img src="https://saturaspace.com/media/game-mud-rider.jpg" width="100%" alt="Mud Rider"></a><br><b>Mud Rider</b> · $9.19<br><a href="https://saturaspace.com/play/mudbike/">Play</a> · <a href="https://github.com/saturadev/mud-rider">Source</a></td>
<td width="25%" valign="top"><a href="https://saturaspace.com/play/icedig/"><img src="https://saturaspace.com/media/game-chisel-peak.jpg" width="100%" alt="Chisel Peak"></a><br><b>Chisel Peak</b> · $10.35<br><a href="https://saturaspace.com/play/icedig/">Play</a> · <a href="https://github.com/saturadev/chisel-peak">Source</a></td>
</tr>
</table>

Two playable ads made the same way, each one HTML file under the ad size limit:
[Agent Match](https://saturaspace.com/play/agent-match/) ([source](https://github.com/saturadev/agent-match-playable))
and [Helix Jump](https://saturaspace.com/play/helix-jump/) ([source](https://github.com/saturadev/helix-jump-playable)).
More at [saturaspace.com/playables](https://saturaspace.com/playables).

## Quick start

1. Download the latest release from [GitHub Releases](https://github.com/saturadev/satura-space/releases/latest):
   macOS on Apple Silicon (`.dmg`) or Windows x64 (`.exe`). The app updates itself from the same page.
2. Open a Unity 6 project in it (Unity Hub must be signed in).
3. Start an agent and tell it what game to make.

You need Unity 6 and a coding agent CLI on your PATH. Bring your own AI subscription: Satura Space
doesn't resell tokens or ask for an API key. It's still in alpha.

## Inside the studio

- **The hand-off.** The agent sets up the moment, then opens a Tuner on what needs your eye: a small
  Unity editor in a panel with the hierarchy, a scene view, Unity's real Inspector and an animation
  timeline, in Edit or Play Mode. The rest of the scene goes gray. You tune it by feel, and Copy
  Changes hands your edits back to the agent.
- **Drift.** A small pixel jellyfish that shows you around. Ask the agent what something is, or press
  Ask Drift in a Tuner, and Drift flies the camera to it and points at the field to tweak.
- **Staging prefabs.** The agent puts one mechanic on a small set of its own and writes its scenarios
  in C#. Press ▶ in the Tuner to run them. When one fails, you see which check broke and on what line,
  with a chart of the run and the path it took.
- **Scratchpads.** Every agent gets its own Unity, so several build at once. Open a Tuner on any of
  them and tune it live.
- **Multiplayer clones.** Up to three clones run beside the primary editor, each with its own stream,
  console and input. They share your Library, so they boot in seconds.
- **One tool.** Other Unity bridges give the agent a catalog of tools, and every pick is another round
  trip. Satura Space registers one, `satura_exec`. The agent writes a few lines of JavaScript, and
  each line waits until its work is done, like Play starting or a video being saved. The same API
  opens Tuners and drives Drift, clips, scratchpads and the app itself.
- **Reports.** At the end of a feature the agent leaves a report beside its terminal: each check, the
  numbers before and after, and the recorded run.
- **C# hot reload.** Method bodies change in Play Mode without a domain reload.

The editors run hidden. Your keyboard and mouse reach the game through the stream, and when you want
the real window, reveal the editor: it's the same process, so nothing relaunches.

## Supported agents

Claude Code, Codex, Cursor, Grok Build, Kimi and opencode, whichever are on your PATH. Every terminal
is a real shell. Claude Code, Codex and Cursor get the Unity MCP server registered automatically.

## What it changes in your Unity project

Nothing you commit. The engine goes in as an embedded package (`Packages/com.saturaspace.engine`),
next to a `.sspace/` folder, an `Assets/csc.rsp` that defines `SATURA_SPACE`, and MCP registration for
your agents. The app lists all of them in `.git/info/exclude`, so git doesn't see them, and adds
nothing to `Packages/manifest.json` or `.gitignore` (it removes the `com.saturaspace.sdk` entry older
versions added). The engine stays out of player builds, and game
code that uses it sits inside `#if UNITY_EDITOR && SATURA_SPACE`, so a clone opens and builds in
plain Unity without Satura Space. Unity itself still records the engine in
`Packages/packages-lock.json`; a lock committed that way is harmless, and plain Unity drops the entry.

Outside the project, Codex gets the MCP server in `~/.codex/config.toml`, and Claude Code, Cursor,
Kimi and Grok Build get hooks in their config folders so the app can tell when an agent is working,
done or waiting for you.

## What works and what doesn't

| Works today | Not supported |
|---|---|
| Unity 6 with the Mono scripting backend, tested on 6000.6 and 6000.3 | Unity 2022 and 2021 LTS |
| Streamed input that works like Unity's Game View, for the Input System, uGUI, TextMeshPro and OnGUI | Input Manager (Old) or Both: the project won't launch until it uses the Input System |
| Hot reload of method bodies in Assembly-CSharp, asmdefs and embedded packages | Hot reload of new fields, methods and types (those take a normal recompile) |
| macOS on Apple Silicon, Windows x64 | Intel Macs, Linux |
| Claude Code, Codex and Cursor with the Unity MCP registered for them | MCP auto-registration for Grok Build, Kimi and opencode |

Blocked by something in the right column? Say so in an
[issue](https://github.com/saturadev/satura-space/issues/new/choose).

## Privacy

Everything runs on your machine, and you don't need an account (only Satura Remote does). There's
no telemetry and no crash reporting. Frames move over a shared GPU texture and everything else over
local loopback.

The app itself goes online to check GitHub Releases for updates. Other traffic comes from what you
run: your agents talk to their providers, the MCP
server downloads Unity's C# reference source from GitHub and reads Unity's Scripting Reference when
an agent asks for them, dashboard tiles fetch the URLs they're written to fetch, and the Kimi usage
meter asks Kimi's API with your own Kimi login. Satura Remote stays off until you turn it on to
pair a phone; from then on the app connects to the hosted relay (`relay.saturaspace.com`) and,
every few hours, checks the hosted phone app (`remote.saturaspace.com`) against its build attestation
on GitHub (`api.github.com`).

## Satura Remote

Satura Remote is a phone web app for tuning and checking on agents away from the desk. It runs in
the phone's browser at [remote.saturaspace.com](https://remote.saturaspace.com) or as a Home Screen
app. It's free when the phone is on the same Wi-Fi as the
desktop; over the internet it's a monthly subscription, managed at
[app.saturaspace.com](https://app.saturaspace.com). The desktop app stays free. The code is in
[`packages/companion-app`](packages/companion-app/README.md).

## Build from source

```bash
cd apps/orchestrator
corepack pnpm@10.34.9 install
corepack pnpm@10.34.9 dev
```

This needs Node 24 and pnpm 10, and Python 3.12 or newer for the MCP server. On Windows, build the
native helpers first. [CONTRIBUTING.md](CONTRIBUTING.md) covers both platforms, the repository layout,
the checks and the dev-instance workflow.

## Community

- Site: [saturaspace.com](https://saturaspace.com)
- X: [@saturadev](https://x.com/saturadev)
- Bugs: **Report a bug** in the app fills in your version and OS, or open an
  [issue](https://github.com/saturadev/satura-space/issues/new/choose).
- Security issues: see [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE), except the Satura Remote relay in `packages/companion-app`, which is under the
[Elastic License 2.0](packages/companion-app/LICENSE): use it, change it and run it for yourself, but
don't offer it to others as a hosted or managed service. Third-party code and assets keep their own
licenses, listed in [NOTICE](NOTICE).
