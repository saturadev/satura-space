# Unity

## Editor state

```js
await unity.status()                 // first line 'Unity: <phase>' (missing, installing, launching, importing, compiling, ready, failed…) with the reason and Next; then RUNNING | BUSY | BLOCKED | DOWN, Play, scenes, errors
await unity.dialogs()                // [{ id, title, message, buttons, textComplete }]
await unity.answer('Save', { id })   // press a button; id only when several are open
await unity.closeDialog(id)          // a dialog without buttons
await unity.relaunch()               // back in Edit Mode, clones removed; returns compile errors if boot fails
await unity.relaunch({ timeout: 900 })   // first boot without a Library folder
await unity.relaunch({ timeout: 1800 })  // project's Unity version missing: waits while the user installs it in Unity Hub
await unity.shutdown()               // only when the user asks
```

State can lag a couple of seconds. Call `status()` when an action seems to have done nothing.

## C# with unity.exec

The snippet is the body of `static void Run()`. It returns what `Print()` printed. Nothing is sandboxed or rolled back. Use it instead of editing .unity, .prefab or .asset YAML.

```js
return await unity.exec(`
  var door = GameObject.Find("Level/Door");
  Undo.RecordObject(door.transform, "Raise door");
  door.transform.position += Vector3.up;
  Print(PathOf(door) + " " + door.transform.position);
`, { usings: 'UnityEngine.UI; TMPro' })
```

```
Print(object v)                        add to the output
PathOf(obj)                            hierarchy path, the one tuner, drift and SaturaClips take
RunDeferred(Action a)                  next editor tick; Print is lost there, use Debug.Log
SceneActuallyDirty(Scene s)            real unsaved state (scene.isDirty reads true during exec)
UserFeedback(Vector3 cam, Vector3 at)  show the user a render from that pose (Edit Mode)
SameMoment(double seconds)             a unix-ms time shared by every player of this call
```

- Imported: UnityEngine, SceneManagement, UnityEditor, EditorSceneManager, SaturaSpace, System, IO, Text, Linq, Collections.Generic. `Instantiate`, `DestroyImmediate`, `FindObjectsByType` need no prefix.
- `return x;` doesn't compile: Print it. No local functions: use `Func<>` or `Action` lambdas.
- Static fields live until the next recompile.
- The first exec after a start or recompile warms the compiler, up to about 25 s. It isn't stuck.
- With project compile errors the snippet runs against the last good build and a note lists them.
- Multiplayer: `{ player: 'all' | 'clones' | 2 }` returns `[{ player, role, output }]`.

## Saving

```js
await unity.openScene('Assets/Scenes/Other.unity')                         // throws while the open scenes are unsaved
await unity.openScene('Assets/Scenes/Other.unity', { unsaved: 'discard' }) // only when the user said so
```

Scene edits stay in memory and the notes name the unsaved scene. AssetDatabase and PrefabUtility writes hit disk at once: make them only when the user wants the change kept.

## Compile and Play

```js
await unity.refresh()                          // import + compile, throws CompileError; Edit Mode only
await unity.play('Assets/Scenes/Pond.unity')   // compiles first, plays every player; no scene = the open one
await unity.play({ refresh: false })            // open scene, skip the compile
await unity.stop()                             // safe when nothing plays
```

A WARNING note after `play` means a player fell back to Edit Mode: call it again. In Play Mode .cs changes don't compile and scene edits are lost on Stop.

## Hot reload

```js
await unity.play('Assets/Scenes/Pond.unity', { hotReload: true })
```

Save a .cs file and changed method bodies patch into the running game; call your handles again. New members, types, handles or signatures need `unity.stop()` and `unity.refresh()`. Errors show up in the console as `[HotReload] ...`.

## Frame rate

```js
await unity.capFps(10)                 // the panel's Target FPS; survives Play, recompiles, restarts
await unity.capFps(30, { player: 2 })
await unity.fps()                      // { cap, playing, targetFrameRate, vSyncCount, fps, setBy: 'cap' | 'game' }
await unity.uncapFps()
```

The cap beats the game's own `targetFrameRate` and `vSyncCount`. With no cap, the game's settings apply. Everything but `cap` reads in Play Mode only.

## Stream size

```js
await unity.resolution('1920x1080')                 // the panel's stream resolution; kept per project
await unity.resolution('1280x720', { player: 2 })
await unity.resolution()                            // { player, size, recording? }
```

The game renders at this size and the panel scales it. A running video recording keeps its own size until it stops.
