# Monetization

Reference, no functions. How web games earn, the ad rules every portal shares, and where each platform keeps its current rules. Read it when the user wants ads, purchases or revenue in a web build.

## Facts come from the source, not from here

Limits, revenue shares, SDK versions, method names and review rules change. Don't take them from this page or from memory. Before integrating or advising, read the platform's current docs and say which page you read. Prefer the pages written for machines:

| Platform | Read first |
|---|---|
| Playgama, and portals through the Bridge SDK | https://wiki.playgama.com/llms.txt (any page + `.md`); with its MCP connected, `get_bridge_sdk_docs` and `get_game_checklist` |
| Yandex Games | https://yandex.com/dev/games/doc/en/llms.txt (any page + `.md`) |
| Wavedash | https://docs.wavedash.com/llms.txt |
| Poki | https://developers.poki.com/ (requirements, monetization, the SDK page for Unity) |
| CrazyGames | https://docs.crazygames.com/ (Requirements → Advertisement, SDK → Video ads) |
| YouTube Playables | https://developers.google.com/youtube/gaming/playables/reference/monetization |
| Facebook Instant Games | https://developers.facebook.com/documentation/games/launch/overview (any page + `.md`) |
| GameDistribution | https://gamedistribution.com/developers/ |
| Own site | https://developers.google.com/ad-placement (Google H5 Games Ads, needs AdSense approval) |

When a link moved or a page says something different from this guide, the page wins. Tell the user what changed.

## What holds everywhere

- **Only the platform's ads.** A portal allows ads from its own SDK only: no other network, no ad images, usually no links out and no purchases unless it offers them. So the ad integration differs per platform. Either one build per platform with its SDK, or one cross-platform layer (Playgama Bridge, MIT for Unity at https://github.com/playgama/bridge-unity) that calls each platform's SDK.
- **The same five moments.** Loading finished; gameplay start (first input, every resume); gameplay stop (pause, menu, level end, game over); a natural break for a full-screen ad; a rewarded ad the player asked for.
- **Full-screen ads** only at natural breaks, never during play or on a menu button. Request at every good break and let the SDK decide frequency: no ad timers of your own. Pause, disable input and mute while one plays. When none comes, carry on.
- **Rewarded ads** are optional extras with a video icon and the exact reward on the button, an equally visible plain option beside it, the reward only on the SDK's success callback, one ad per reward.
- **Ad blockers** never stop the game. No custom "ad blocked" messages.

## In this project

- Ask which platform the build is for before adding any SDK, unless the user already said.
- Put the SDK in `Assets/` the way the platform's Unity page says, so the game builds without Satura Space. In the editor the calls must do nothing harmful: guard them for WebGL builds or use the SDK's editor stubs.
- Route ad moments through one small class of the game's own, so another platform's SDK is a change in one file.
- Real ads only show on the platform or in its test tool (Poki Inspector, CrazyGames QA tool, YouTube Playables Test Suite, Playgama QA tool). Say so, and test the event flow there.

## Pages for the user

Three HTML pages sit next to this file in `monetize/`: `index.html` (how web games earn), `ads.html` (placing ads), `platforms.html` (where each platform's rules live). Open one for the user when they ask how monetization works:

```js
await report.open('Packages/com.saturaspace.engine/Documentation~/agent-guide/monetize/index.html')
```
