# Clip to game

The user pasted a link to a short video (TikTok, Reels, Shorts, X, anything) when they made this project. Satura Space already downloaded it and cut it into frames. Your job: build a small, original, playable game inspired by what the clip shows, film it, and render one video with the clip next to the gameplay, ready to post.

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

## 1. Understand the clip

Open all frames and read the brief. Work out what is fun about it: the motion, the satisfying moment, the rhythm, the thing a player would want to do. Read any on-screen text from the frames. Nobody transcribed the audio, so captions exist only when the brief lists them.

## 2. Originality is a hard rule

- Never recreate a specific existing game: its name, characters, art, music, levels or look, even when the clip shows one. Take only the general mechanic and the feeling, and make everything else your own.
- Real-life trends, memes, animals, physics and oddly satisfying clips are the best material. Build the toy or the challenge behind them, not a copy of the footage.
- Don't use the creator's footage, voice, music or likeness inside the game. The clip appears only in the final video, with credit.

Tell the user the idea in three lines before you build: the game's name, the one thing the player does, and what it borrows from the clip's feeling. Then build without waiting.

## 3. Build it small

One scene, one verb, a clear goal and a score, restart on fail. No menus and no level list. A viewer must understand it in two seconds of footage. Use primitives, simple shaders and particles; for real-looking props see the Free Assets plugin if it is listed in the guide. Follow the usual rules: Input System only, Satura code inside `#if UNITY_EDITOR && SATURA_SPACE`, don't save unless the user asks.

Make the footage easy to film. Add a `[SaturaHandle]` that starts a run and one that plays it by itself with a simple bot, so the gameplay looks good without a human at the controls. See [handles](handles.md).

## 4. Film the gameplay

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

See [video](video.md). Keep the file inside the project. Film test takes into `.sspace/videos/`, so `ClipToGame/` ends up with only `source/`, `gameplay.mp4` and the final video.

## 5. Render the final video

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

## 6. Hand it over

Say in a few lines: what the game is, how to play it, the path of the video, and the clip's link and author so the user can credit them when posting. Don't call it a recreation of anything.
