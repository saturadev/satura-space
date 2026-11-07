# Handles

Public static methods marked `[SaturaHandle]` that set up one moment, do one action or read state. Drive the game with them one call at a time and read each result.

```js
await handles.list()                                    // the tree of groups, signatures and descriptions
await handles.list('Fishing')                           // one group and the groups inside it
const r = await handles.call('Fishing/CastRod', 0.8)    // { handle, status: 'done', value, logs }
await handles.call('CastRod', 0.8)                      // a bare name works while it is unique
await handles.call('Teleport', 'Level/Player', [1, 0, 3], { timeout: 20 })
```

The group is the class that declares the handle, and a nested class is a group inside it: `Fishing.Pond.Drain()` is `Fishing/Pond/Drain`. Nesting can go as deep as you like, but keep it flat: one class per feature is usually enough. Handles on a staging prefab are grouped by its name in the scene, like `DoorStaging (2)/Unlock` (see [staging](staging.md)).

Arguments: numbers, strings, booleans, enum names, vectors as arrays, GameObject paths. A plain object last is the options. A wrong name throws HandleError with the closest names. A handle that fails in Edit Mode may need `unity.play()` first.

## Coroutines

```js
const bite = await handles.call('WaitForBite', 10)          // waits up to 60 s, value = last yield
const { run } = await handles.call('Patrol', { wait: false })
await handles.result(run)                                   // status now
await handles.result(run, { wait: true, timeout: 30 })      // waits, throws HandleError or HandleTimeout
await handles.stop(run)
```

Past its timeout a coroutine throws HandleTimeout and keeps running. Runs are lost on recompile and fail when Play ends.

## Multiplayer

```js
const all = await handles.call('Jump', { player: 'all' })   // one result per player, each with lateMs
await handles.call('Jump', { player: 'all', at: 2 })        // start 2 s from now
await handles.call('Jump', { player: 2 })
```

`player: 'all'` starts every player at the same wall-clock moment. Don't call them one after another. Player numbers match the panels; `SaturaHandles.PlayerIndex` is the number minus one.

## Writing one

Put it next to the code it drives, in runtime code (not an Editor folder), then `await unity.refresh()`.

The game has to compile and play in plain Unity, where Satura Space isn't installed, and in player
builds, which never get the engine. So every bit of Satura Space in game code, `using SaturaSpace;`
included, goes inside `#if UNITY_EDITOR && SATURA_SPACE`. Satura Space defines `SATURA_SPACE` in its
own `Assets/csc.rsp`, which stays out of git.

```csharp
#if UNITY_EDITOR && SATURA_SPACE
using SaturaSpace;
#endif

public static class FishHandles
{
#if UNITY_EDITOR && SATURA_SPACE
    [SaturaHandle("Clears the pond and puts the player on the dock with the rod")]
    public static void PrepareStageForFishTest() { ... }

    [SaturaHandle("Waits until a fish bites or the time runs out. Yields whether it bit.")]
    public static IEnumerator WaitForBite(float seconds) { ... yield return bit; }

    [SaturaHandle("How deep the fish is")]
    public static float GetFishDepth() => fish.position.y;
#endif
}
```

A tagged log line in game code gets the same guard:

```csharp
#if UNITY_EDITOR && SATURA_SPACE
        SaturaLog.Log("fish", $"bite at {Time.time}");
#endif
```

Read tagged lines with `unity.logs({ tag: 'fish' })`. `unity.refresh()` lists every Satura Space use
outside the guard with its file and line. Code in an asmdef also needs `SaturaSpace.Sdk` in the
asmdef's references; a reference Unity can't find is skipped, so plain Unity still compiles it.
