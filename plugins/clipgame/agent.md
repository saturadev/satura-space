# Clip to game

The user pasted a link to a short video (TikTok, Reels, Shorts, X, anything) when they made this project. Satura Space already downloaded it and cut it into frames. Your job: build a small playable game that plays like the clip, with the same camera, the same core action, the same threat and the same mood, and with your own names, characters and art. Then film it and render one video with the clip next to the gameplay, ready to post.

```
ClipToGame/source/brief.md      read this first: link, author, length, description, hashtags, captions, the frame list
ClipToGame/source/frames/*.jpg  evenly spaced frames, open every one in order
ClipToGame/source/clip.mp4      the original clip
ClipToGame/source/meta.json     the same facts as data: await clipgame.info()
```

## Starting from a link in any project

When the user gives you a video link and `ClipToGame/source/brief.md` doesn't exist yet, fetch it into this project first:

```js
return await clipgame.fetch('https://www.tiktok.com/@name/video/123')
```

It downloads the clip with yt-dlp, cuts it into frames and writes `ClipToGame/source/`, then returns `{ title, author, credit, site, duration, width, height, frames, captions, placed }`. Set the satura_exec tool `timeout` to 600 for the first call on a computer, which also sets up the tools. An error says why in words (private video, removed, not a video page, no internet, no Node.js 18+): tell the user and stop. In a project that already has a game, don't touch it: build the new game in its own scene and folder, `Assets/ClipGame/<name>/`, and leave the existing scenes and scripts alone.

## 1. Describe the clip first

Open every frame in order and read the brief. Before any idea, write `ClipToGame/analysis.md`: plain facts about what the clip shows, in your own words.

- **Camera.** First person, third person, top-down or side view; what moves; portrait or landscape.
- **What the player does.** The action, verb by verb, in the order it happens: reaches, throws, runs, dodges, stacks, drops.
- **The opposition.** What chases, blocks, falls or fails, and what makes the moment tense or satisfying.
- **The place.** The environment, its scale, colours, light and mood: grey and eerie, bright and cartoony, a messy kitchen, a night street.
- **The goal or the ending**, and any on-screen text. Read it from the frames: the title and hashtags in the brief often name the genre.
- **The moment people replay.**

Nobody transcribed the audio, so captions exist only when the brief lists them.

## 2. Look for the best open-source solutions on GitHub

Before you write game code, spend a few searches finding how others solved this clip's core mechanic well: the movement, the physics, the enemy behaviour, the camera, the water or whatever the clip is about. Use `gh search repos "<mechanic> unity" --language "C#" --sort stars --limit 10` when `gh` is installed, otherwise your web search or fetch tools on github.com. Open the two or three best matches, read their README and the scripts that do the core work, and note the technique that fits a small game.

- **Licences.** Adapt code only from repositories under MIT, Apache-2.0, BSD, Unlicense or CC0. No licence, GPL or a custom licence means read it for ideas and write your own version.
- **Credit.** For anything you adapt, add a line to `Assets/ThirdParty/CREDITS.md` with the repository URL and its licence.
- **Never.** Don't copy a whole game, any game's assets, or code you can't use. Take techniques, not content.
- **Keep it short.** A handful of searches, not a research project. If nothing fits, build the mechanic yourself.

Write what you found and what you will use at the end of `ClipToGame/analysis.md`.

## 3. Make a game that plays like the clip

The final video puts the clip beside your gameplay, so viewers compare them at a glance. Copy what the clip's gameplay is, not only its mood.

- **Keep from the clip:** the camera and perspective, the player's core action and how it feels to control, the threat or challenge and its pace, the kind of place with its mood and light, and the goal or ending. Someone who sees both should say "same kind of game".
- **Make your own:** the name, every character and creature design, logos, interface art, music, level layouts, models and textures. Build them from primitives, shaders and particles.
- **Never:** reuse another game's name, characters, art, music or levels, even when the clip shows that game. Take its mechanics and situation, not its content. Don't use the creator's footage, voice, music or likeness inside the game; the clip appears only in the final video, with credit.
- **Don't drift.** Don't swap the clip's setting for an unrelated cute or colourful theme, don't invent a different verb, and don't soften the mood. A grey, eerie clip gets a grey, eerie game; a chaotic kitchen clip gets a chaotic kitchen.

Tell the user the plan in six short lines before you build: camera, what the player does, what threatens them, the place and mood, the goal, and what is your own (name, characters, art). Then build without waiting.

## 4. Build it small

One scene, the clip's one core verb, a clear goal and a score, restart on fail. No menus and no level list. A viewer must understand it in two seconds of footage. Use primitives, simple shaders and particles; for real-looking props see the Free Assets plugin if it is listed in the guide. Follow the usual rules: Input System only, Satura code inside `#if UNITY_EDITOR && SATURA_SPACE`, don't save unless the user asks.

Make the footage easy to film. Add a `[SaturaHandle]` that starts a run and one that plays it by itself with a simple bot, so the gameplay looks good without a human at the controls. See [handles](handles.md).

## 5. Film the gameplay

Match the clip's shape: a portrait clip (`height > width` in `meta.json`) wants a portrait game view, so film with `size: '1080x1920'`; a landscape clip, `'1920x1080'`. Check the framing with `unity.screenshot` first, then film 10 to 25 seconds that show the hook in the first two seconds.

```js
const mp4 = await video.record(async () => {
  await unity.play('Assets/Scenes/Main.unity')
  await handles.call('DemoRun')
  await sleep(15000)
}, { size: '1080x1920', audio: false, path: 'ClipToGame/gameplay.mp4' })
await unity.stop()
return mp4
```

See [video](video.md). Keep the file inside the project. Before you render, look at four frames of your gameplay beside four frames of the clip. If the camera, the action, the threat or the mood differ, fix the game and film again; do this at least once. Film test takes into `.sspace/videos/`, so `ClipToGame/` ends up with only `source/`, `gameplay.mp4` and the final video.

## 6. Render the final video

```js
const r = await clipgame.render({ gameplay: 'ClipToGame/gameplay.mp4', title: 'This clip became a game' })
await video.open(r.path)
return r
```

Set the satura_exec tool `timeout` to 900 for this script: the first render on a machine installs Remotion and its browser, which takes minutes. The result is `{ path, absolute, seconds, width, height, bytes }`, by default `ClipToGame/clip-vs-game.mp4`.

| Option | Meaning |
|---|---|
| `gameplay` | the recorded video, a path inside the project (required) |
| `title` | a short headline at the top, or leave it out for none; no more than six words |
| `credit` | the line at the bottom, default `Inspired by @author` from the source; keep the credit |
| `layout` | `'side'` (default, 1920x1080, clip left, game right) or `'stack'` (1080x1920, clip above, game below; for a landscape clip with landscape gameplay) |
| `sound` | `'none'` (default), `'game'` or `'clip'`; the clip's audio is the creator's, so leave it off unless the user says otherwise |
| `endCard` | `false` drops the closing Satura Space card |
| `out` | another path inside the project |

If the call throws a message about Node.js, tell the user to install Node 18 or newer from https://nodejs.org and then call it again; the source frames and your gameplay stay where they are.

## 7. Hand it over

Say in a few lines: what the game is, how to play it, the path of the video, and the clip's link and author so the user can credit them when posting. Don't call it a recreation of anything.
