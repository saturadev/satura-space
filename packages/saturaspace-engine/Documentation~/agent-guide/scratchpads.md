# Scratchpads, modes and clones

## Scratchpads

Empty projects with this project's Unity version, packages and settings, for experiments. They run in the Scratchpads panel.

```js
const pad = await scratchpad.create('water-shader', { mode: 'headless-graphics' })   // first boot imports for minutes
pad.id; pad.name; pad.path; pad.report                                   // report: what create printed
const list = await scratchpad.list()                                      // status, name, id, path
const same = await scratchpad.get('water-shader')                         // name, id or folder, without starting it
await pad.exec('Print(Application.dataPath);')
await pad.play()
await pad.handles.call('DropCube')
await pad.video.record(async () => { await pad.handles.call('DropCube') })
await pad.tuner.open({ scene: true })                                     // same as tuner.open({ scratchpad: 'water-shader', ... })
await pad.resolution('1920x1080'); await pad.capFps(30)
await pad.addPlayer(); await pad.players(); await pad.removePlayer()      // its own multiplayer group
await scratchpad.import('water-shader', ['Assets/Shaders/Water'])
await scratchpad.export('water-shader', ['Assets/Shaders/Water'], { overwrite: true })
```

`create`, `start`, `restart` and `get` return the scratchpad: its `id`, `name` and `path`, and the same calls as `unity`, run on its editor: `pad.stop()` stops its Play Mode, `scratchpad.stop(pad.id)` stops the editor. `unity.at(pad.path)` gives the same calls. `create`, `start` and `restart` wait up to 300 s (`{ wait: false }` returns at once). `stop`, `rename`, `remove` (deletes Library, Temp, Logs and obj, moves the rest to the Trash). import and export copy .meta files and dependencies; export replaces nothing without `overwrite`.

## Unity modes

```js
await unity.mode()                              // { mode, kind, running, lifecycle, pid }
await unity.setMode('headless-nographics')      // relaunches a running editor, waits for Edit Mode
await pad.setMode('normal', { wait: false })
await scratchpad.restart(id, { mode: 'headless-graphics' })
```

| Mode | |
|---|---|
| `normal` | hidden editor window, streams to the panel, can be revealed |
| `headless-graphics` | batch mode with a GPU; the panel still streams |
| `headless-nographics` | no GPU, no video, one player; lightest for compile, handles, logic |

In `headless-nographics`, `screenshot`, `video.*` and `tuner.open` throw NoGraphicsError. A stopped project keeps its mode. Clones have no mode: they're always hidden windows.

## Multiplayer clones

```js
await unity.addPlayer()                          // minutes the first time; Edit Mode only
await unity.players()
await unity.play()                               // plays the whole group
await unity.exec('Game.Speed = 2;', { player: 'all' })   // runtime change, gone on Stop
await unity.exec('Print(Time.time);', { player: 2 })
await unity.removePlayer()                       // the last one
```

On a scratchpad, call them on its object: `pad.addPlayer()`, `pad.players()`, `pad.removePlayer()`.

Edit the script only when the user wants a change kept. See [handles](handles.md) for synced calls.
