# Screenshots and video

## Screenshot

A temporary 60° camera, Edit or Play Mode. It shows the world, not the player's screen.

```js
await unity.screenshot({ camera: [0, 5, -10], lookAt: [0, 0, 0] })   // image attached
await unity.screenshot([poseA, poseB, poseC])                         // one grid image
const png = await unity.screenshot(pose, { save: true })              // a path, for a report
await unity.screenshot({ frame: 'Hero', angle: 'three-quarter' })     // camera fits the object's bounds
await unity.screenshot({ frame: 'Hero', angle: 'front', distance: 3, isolate: true })
await unity.screenshot({ camera: [0, 2, -6], lookAt: [0, 1, 0], hide: ['Env/Grass', 'Env/Trees'] })
```

`angle` is 'three-quarter' (default), 'front', 'back', 'left', 'right', 'top' or `{ yaw, pitch }` in degrees, from the object's facing. `isolate: true` draws only the framed object, or pass paths; `hide` drops objects and terrains from this shot only. Nothing in the scene changes.

Don't call ScreenCapture from game code.

## Record the panel

What the user sees. The panel streams only in Play Mode, so enter Play before or inside the recording.

```js
const mp4 = await video.record(async () => {
  await unity.play('Assets/Scenes/Pond.unity')
  await handles.call('CastRod', 0.8)
  await handles.call('WaitForBite', 10)
}, { size: '1920x1080', audio: false, path: '.sspace/videos/cast.mp4' })
await unity.stop()
return mp4
```

Segments without gaps:

```js
await video.clear()
await video.start(); await handles.call('CastRod', 0.8); await video.stop()
await video.start(); await handles.call('Reel'); await video.stop()
return await video.finish({ path: '.sspace/videos/cast-and-reel.mp4' })
```

60 fps, 15 minutes at most, one player at a time (`{ player }`). Without audio the game clock moves at most 1/60 s per rendered frame, so a slow editor slows the game and the video stays smooth. An unsaved stopped video is dropped after 15 minutes. `video.status()`, `video.open(path)` plays it in a panel.

In a report a video without sound scrubs frame by frame: drag the timeline or step one frame, and the exact frame shows. Silent recordings get a key frame every 1/4 s for this. A video with sound gets a normal player with volume and full screen. Record with `audio: true` only when the sound matters.

## Cameras you place

Up to 6 cameras film the same frames in Play Mode, each to its own .mp4, so the clips play in sync.

```js
await unity.play('Assets/Scenes/Pond.unity')
const { paths, names, seconds, wallSeconds } = await video.cameras([
  { name: 'bobber', follow: 'Rod/Bobber', position: [0.8, 0.5, -1.5], fov: 40 },
  { name: 'pond', position: [0, 9, -6], lookAt: 'Pond' },
  { name: 'top', position: [0, 20, 0], rotation: [90, 0, 0] }
], async () => {
  await handles.call('CastRod', 0.8)
}, { seconds: 6, fps: 30, size: '1280x720' })
```

- `lookAt`: a point or an object path (the centre of its renderers). `rotation`: euler degrees instead. `follow`: position becomes an offset from that object.
- Every video frame is one game frame, the clock stepped 1/fps s. A slow editor slows filming, not the video.
- `seconds` films exactly that much game time, even after `steps` returns. `sleep(4500)` in steps is real time.
- Entering or leaving Play ends the recording and keeps what was filmed (`note` says so).
- Options: `size` (1280x720), `fps` (30, max 60), `seconds`, `folder` (.sspace/videos/cameras-<time>), `player`.

Frame what the viewer must see, close and unblocked; check the pose with `unity.screenshot` first. One angle can't show both the hit and the arena? Use two cameras in one `<Videos>`:

```jsx
<Videos title="Cast">
  <Video id="bobber" src="bobber.mp4" label="bobber" />
  <Video id="pond" src="pond.mp4" label="pond" />
</Videos>
```
