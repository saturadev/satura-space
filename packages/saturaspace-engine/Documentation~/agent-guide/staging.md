# Staging

A staging prefab sets up a small situation to check how one prefab behaves in it: a nested instance of the prefab under test, the floor, walls, enemies or props it needs, and a script that derives from `SaturaStaging`. A staging scene holds several staging prefabs side by side. It's a debug scene: leave it out of Build Settings.

Without Satura Space the staging script must still be a component, or the prefab and scene get a missing script: derive from `StagingBase`, an alias that is `SaturaStaging` under Satura Space and `MonoBehaviour` everywhere else, and keep the fields outside the guard so their values survive. Everything that uses Satura Space goes inside `#if UNITY_EDITOR && SATURA_SPACE` ([handles](handles.md) says why).

```csharp
using System.Collections;
using UnityEngine;
#if UNITY_EDITOR && SATURA_SPACE
using SaturaSpace;
using StagingBase = SaturaSpace.SaturaStaging;
#else
using StagingBase = UnityEngine.MonoBehaviour;
#endif

public class DoorStaging : StagingBase
{
    public Door door;
    public Walker player;

#if UNITY_EDITOR && SATURA_SPACE
    [SaturaScenario("The player walks up and the door opens")]
    IEnumerator OpensWhenPlayerWalksIn()
    {
        player.Move(Vector3.forward);
        yield return new WaitForSeconds(2);
        Check(door.IsOpen, "door open");
    }

    [SaturaScenario("Jumps again and again", Loop = true)]
    IEnumerator JumpLoop() { ... }

    [SaturaHandle("Unlocks the door")]
    void Unlock() => door.locked = false;
#endif
}
```

- A scenario is a coroutine on the staging script. It passes when it ends; a failed `Check(condition, what)` or an exception fails it. Passed checks are logged.
- Scenarios run in Play Mode with the real game code, only in the staging scene. Running one from Edit Mode enters Play first. Several staging prefabs can run at once; each one is separate.
- Running a scenario again on the same staging prefab replaces it with a fresh copy (the state it had when Play started), so every run starts clean.
- `Loop = true` makes the runner call the scenario again after each pass, on the same instance, and it resets nothing in between. Reset what you need at the top of the scenario; the user's inspector changes carry into the next pass. A failed pass is logged and the loop goes on until it is stopped.
- `[SaturaHandle]` instance methods on the staging script are handles grouped by the instance's name.
- If the staging script has its own `Awake`, it must be `protected override void Awake()` that calls `base.Awake()`, or the reset loses the scene's overrides. Put that header and `base.Awake();` inside the guard, with a plain `void Awake()` header in its `#else`.

```js
await handles.list('DoorStaging (2)')
const r = await handles.call('DoorStaging (2)/OpensWhenPlayerWalksIn')   // { status, result: 'pass' | 'fail', error, logs, video }
await handles.call('DoorStaging (2)/Unlock')
const loop = await handles.call('JumpStaging/JumpLoop')                  // returns after the first pass and keeps looping
await handles.result(loop.run)                                           // iterations, passed, failed, lastError
await handles.stop(loop.run)                                             // ends the loop and saves its video
```

## Report

A scenario can record what happened, for the panel's report and for you:

```csharp
[SaturaScenario("One jump lands on the low ledge")]
IEnumerator LandsOnLedge()
{
    Step("place");
    Track(jumper);                                     // world path, drawn in the Tuner scene view
    Place();
    yield return new WaitForSeconds(0.3f);
    Step("jump");
    jumper.Jump();
    for (float t = 0; t < 2; t += Time.deltaTime)
    {
        Plot("height", jumper.transform.position.y, 0, 2.2f);   // one chart point per call, band optional
        yield return null;
    }
    Snapshot("landed");                                // small JPEG of the staging prefab
    Metric("peak", peak, "m", 0.8f, 2.2f);             // a number; a range also makes it a Check
    Check(OnTop(ledge), "landed on the ledge");
}
```

- Times count from the start of the run, or of the pass for a loop. Call `Plot` every frame. The band is only drawn: `outside` counts the samples past it and the run still passes. Use `Check` or a `Metric` range to fail it.
- `Metric` keeps the last value per name. `prev` is the value from the previous run, or from the previous pass of a loop.
- `Track` follows the object until the run ends. `Step` starts a phase that lasts until the next one. `Snapshot` saves a 480×270 frame under `.sspace/staging/snapshots`, for panel runs too.
- Limits per run: 8 plots of 240 points per pass (longer runs are downsampled), 4 tracked objects, 16 metrics, 24 steps and 64 checks per pass, the last 5 passes of a loop, and the last 12 snapshots (older files are deleted).

`handles.call` returns the report as numbers next to `logs`:

```js
r.metrics     // [{ name, value, unit, min, max, ok, prev }]
r.series      // [{ name, samples, min, max, maxAt, last, band, outside }]
r.steps       // [{ name, t }]
r.checks      // [{ what, ok, t }]
r.snapshots   // [{ name, t, path }]
r.tracks      // [{ name, points, length, from, to }]
```

For a loop they describe the last finished pass, `reportIteration`.

## Staging scenes

A project can have several staging scenes, and only the open one's staging prefabs are loaded. `handles.list()` ends with the project's staging scenes and marks the open one. To run a scenario from another scene, open it first:

```js
await unity.openScene('Assets/Staging/DoorsScene.unity')
await handles.call('SlowDoor/OpensWhenPlayerWalksIn')
```

## Runs

A staging prefab runs one scenario at a time: starting another one of the same prefab fails until the running one ends or you stop it, and `SaturaStaging.RunningScenario` names the one that runs. A failed scenario returns its result instead of throwing. A scenario's `seconds` counts game time, like its charts, so a slow editor doesn't stretch it. Every run you start records a video that frames its staging prefab: `video` is the file, ready for a report `<Video>`. A loop's video covers the whole loop and is saved when it stops. While several scenarios run, each run gets the lines logged inside its own scenario, plus every game log from that time.

The user runs scenarios from the Staging panel in the Tuner (the Staging button next to Animation): ▶ per scenario and ✓ or ✗ for the last run. The panel shows the selected scenario's report, draws its tracked path in the scene view, and its header switches between staging scenes. The user's runs record no video and leave their camera alone; a video link shows only for runs you started.
