# Publishing

Reference, no functions. How a Unity web build gets onto web platforms: the path, the build settings, and how each platform takes builds. Read it when the user wants the game online. Ads and purchases are in the monetization page.

## Facts come from the source, not from here

Upload commands, APIs, size limits and review steps change, and platforms add APIs. Don't take them from this page or from memory. Before building for a platform or uploading, read its current docs and say which page you read. Prefer what is written for agents:

| Platform | How builds go up | Read first |
|---|---|---|
| itch.io | `butler push <dir> <user>/<game>:<channel>` | https://itch.io/docs/butler/ |
| Poki | Poki CLI, made for agents | run `npx @poki/cli` with no arguments for its structured help; https://github.com/poki/poki-cli |
| Playgama | MCP server `https://developer.playgama.com/api/mcp` | https://wiki.playgama.com/playgama/mcp.md, https://wiki.playgama.com/llms.txt |
| Facebook Instant Games | Graph API upload, then push to production | https://developers.facebook.com/documentation/games/launch/upload-bundle.md |
| Wavedash | `wavedash` CLI | https://docs.wavedash.com/llms.txt |
| Own site | Cloudflare Pages via `wrangler`, or any static host | https://developers.cloudflare.com/pages/llms.txt |
| Yandex Games | developer console | https://yandex.com/dev/games/doc/en/llms.txt (any page + `.md`) |
| CrazyGames | developer portal | https://docs.crazygames.com/ |
| GameDistribution | developer console | https://gamedistribution.com/developers/ |
| YouTube Playables | developer portal after onboarding | https://developers.google.com/youtube/gaming/playables |

When a platform's docs say something different from this guide, the docs win. Tell the user what changed.

## Rules

- **The user signs in, never you.** Logins (`butler login`, `npx @poki/cli auth login`, `wrangler login`, an MCP's browser sign-in) run in the user's own terminal or browser. Ask them to run it. Never put keys or tokens in the project, a script or git.
- **Their yes before anything public.** Submitting to review, pushing to production, publishing a sandbox link or updating a live game reaches real players. Prepare it, show what will go out, wait for a direct yes.
- **Console-only platforms:** prepare the zip, the texts and the images, give the user the console link and the list of fields, and stop.
- **Read the platform's requirements before building.** Size, devices, orientation, external requests and content rules differ, and some forbid what a generated game might do (Yandex Games doesn't allow interactive AI inside games).

## Building in this project

- Building switches the editor to the Web platform and reimports assets, and switching back does it again. Tell the user before the first build, and build only when they want one.
- Build outside `Assets/`, into `Builds/Web/<platform>/`, and keep `Builds/` out of git.
- Use the platform's WebGL template when its SDK ships one. Without control of the host's headers, turn on Decompression Fallback or follow the platform's compression advice.
- Package as a zip with `index.html` at its root, plus any config file the platform asks for.
- Test on the platform's preview or QA tool before calling the build ready, and report what you checked there.

## Pages for the user

Three HTML pages sit next to this file in `publish/`: `index.html` (the publishing path), `unity-web.html` (Unity web build settings), `platforms.html` (how and where each platform takes builds). Open one when the user asks how publishing works:

```js
await report.open('Packages/com.saturaspace.engine/Documentation~/agent-guide/publish/index.html')
```
