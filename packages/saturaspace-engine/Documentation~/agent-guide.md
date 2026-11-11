# Satura Space agent guide

`satura_exec` runs the body of an async JavaScript function inside the app. Await every call, return what you want to see. A failed call throws an Error that says what went wrong.

```js
await unity.refresh()
await unity.play('Assets/Scenes/Pond.unity')
await handles.call('PrepareStageForFishTest')
const bite = await handles.call('WaitForBite', 10)
const state = await handles.call('GetFishState')
await unity.stop()
return { bite: bite.value, state: state.value }
```

Rules that come before everything else:

- **Don't save unless the user asks.** No `AssetDatabase.SaveAssets`, `PrefabUtility.SavePrefabAsset` or `EditorSceneManager.Save*`. Leave changes unsaved and say so.
- **Answer questions by showing.** What, why, where or how about the game or the app: `drift.look`, then `drift.show`, then a short reply. See [drift](agent-guide/drift.md).
- **Ask before anything you can't undo**, like deleting assets or wiping a scene.
- **Test exactly what changed, and keep it short.** Check the feature or fix you just made, with as few Play runs, restarts and handle calls as it takes to prove it. Run a regression pass over the rest of the game only when the user asks for one.
- **Input System only.** Unity won't start on the old Input Manager. See [input system](agent-guide/input-system.md).
- **Guard Satura code.** The game must compile and play in plain Unity without Satura Space, so every Satura Space use in game code (`using SaturaSpace;`, `[SaturaHandle]`, `SaturaLog`, staging scripts) goes inside `#if UNITY_EDITOR && SATURA_SPACE`. `unity.refresh()` lists the uses outside it. See [handles](agent-guide/handles.md) and [staging](agent-guide/staging.md).

Read the file for an API before you use it:

| File | What's in it |
|---|---|
| [script](agent-guide/script.md) | the reply, errors, timeouts, what a script can't do |
| [unity](agent-guide/unity.md) | status, dialogs, relaunch, `unity.exec` C#, refresh, Play, hot reload, fps cap |
| [input system](agent-guide/input-system.md) | switching a project over, reading input |
| [phone controls](agent-guide/remote-controls.md) | the phone's game controls: generated layout, overrides, gamepad module |
| [handles](agent-guide/handles.md) | calling and writing `[SaturaHandle]` methods, coroutines, multiplayer |
| [staging](agent-guide/staging.md) | staging prefabs and scenes, `[SaturaScenario]`, `Check`, loops, run videos |
| [debug](agent-guide/debug.md) | `unity.logs`, `unity.trace`, `unity.source`, `unity.docs` |
| [video](agent-guide/video.md) | screenshots, `video.record`, `video.cameras` |
| [clips](agent-guide/clips.md) | SaturaClips keys, events, settings, muscles |
| [scratchpads](agent-guide/scratchpads.md) | scratchpads, Unity modes, multiplayer clones |
| [reports](agent-guide/reports.md) | report.tsx and the report kit |
| [dashboard](agent-guide/dashboard.md) | live tiles, hooks, alerts |
| [plugins](agent-guide/plugins.md) | project plugins in `.sspace/plugins`: a panel, `plugins.*` functions |
| [tuner](agent-guide/tuner.md) | handing values to the user, driving the Tuner |
| [drift](agent-guide/drift.md) | targets, drift verbs, answering questions |
| [app](agent-guide/app.md) | app parts, `page`, snapshot, agents, env files |
