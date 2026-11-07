# Animation clips

Edit .anim assets with SaturaClips in `unity.exec`. It works like Unity's Animation window: one Undo step per call, new clips get wired into the object's animator, the Tuner timeline updates live. Each call returns a summary; a mistake throws SaturaClipException saying what to fix.

```js
return await unity.exec(`
  Print(SaturaClips.Create("Cube", "Hop"));
  Print(SaturaClips.SetKeys("Cube", "Hop",
    SaturaClips.Key("position.y", 0, 0),
    SaturaClips.Key("position.y", 15, 1).Tangent("easeOut"),
    SaturaClips.Key("position.y", 30, 0),
    SaturaClips.KeyAt("rotation.y", 0.5f, 180),
    SaturaClips.Key("m_Intensity", 15, 3).On("Lamp", "Light"),
    SaturaClips.Key("material._BaseColor.r", 15, 1).On("", "MeshRenderer"),
    SaturaClips.Key("m_IsActive", 30, 0).On("Spark", "GameObject")));
  Print(SaturaClips.AddEvent("Cube", "Hop", new AnimationEvent { functionName = "OnLand", time = 0.5f }));
`)
```

```
SaturaClips.List(obj) / Get(obj, clip?) / Describe(obj, clip?)
SaturaClips.Create(obj, name, frameRate: 60, loop: true)       Edit Mode
SaturaClips.SetKeys(obj, clip, params ClipKey[]) / RemoveKeys(...)
SaturaClips.RemoveProperty(obj, clip, prop, path?, type?)      "position" drops x, y and z
SaturaClips.SetEvents(obj, clip, params AnimationEvent[]) / AddEvent(obj, clip, e)
SaturaClips.Settings(obj, clip, length: 2, frameRate: 24, loop: true)
SaturaClips.Delete(obj, clip)                                  to the Trash; Edit Mode
SaturaClips.Key(prop, frame, value) / KeyAt(prop, seconds, value) / Muscle(name, frame, value)
  .On(childPath, componentType) / .Tangent(mode)
SaturaClips.Muscles(filter?) / PathOf(root, child)
```

- `obj`: path, GameObject or component, the animated object or a child. `clip` can be left out when there's one, or be `'Assets/....anim'` with obj null.
- Keys snap to frames. Imported (FBX) clips are read-only. Length follows the keys.
- Create on an object without an animator adds an Animator and a new Animator Controller, like Unity's Animation window, and saves the scene if it had no other unsaved edits.
- Tangents: clampedAuto (new keys), auto, freeSmooth, flat, broken, linear, constant, step, weighted, ease, easeIn, easeOut, easeInOut, `"bezier x1 y1 x2 y2"`.
- `position.*`, `rotation.*` (euler degrees), `scale.*` are local Transform. Anything else is Unity's binding name with `.On(path, type)`, path relative to the animated object.

## Humanoid

```csharp
SaturaClips.Muscle("Spine Front-Back", 20, 0.4f)
SaturaClips.Key("RootT.y", 0, 1).On("", "Animator")
```
