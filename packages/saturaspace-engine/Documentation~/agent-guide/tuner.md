# Tuner

A small Unity editor in the app: scene view, hierarchy, Unity's Inspector, Undo, Save, Discard. Hand one over when a value or placement needs a human eye, then end your turn.

```js
return await tuner.open({
  name: 'arena-lights',
  note: 'Balance the arena lights, then copy your changes to me',
  objects: [{ path: '**', components: [{ type: 'Light', fields: ['m_Intensity', 'm_Color'] }] }]
})
```

The user presses Copy Changes and pastes it to you; `tuner.changes()` returns the same text. Play Mode changes come back as values: apply them yourself in Edit Mode. Ask Drift questions reach you naming the Tuner and selection: answer as in [drift](drift.md).

When the user wants to watch or tune a value, set it in the Tuner so they see it and can undo it:

```js
await tuner.field('Intensity', { section: 'Light' }).set(2.5)
```

## What to show

```js
tuner.open({ scene: true })                               // every loaded scene; reuses the one scene Tuner
tuner.open({ scene: 'Assets/Scenes/Level.unity' })
tuner.open({ ui: 'Canvas/ShopPanel' })                    // Screen Space canvases need ui
tuner.open({ object: 'Level/Crate' })
tuner.open({ prefab: 'Assets/Prefabs/Crate.prefab' })     // one Tuner per prefab
tuner.open({ prefabs: ['Assets/Prefabs/A.prefab', 'Assets/Prefabs/B.prefab'] })
tuner.open({ objects: [{ path: 'Arena/Props', children: true }, { path: 'Arena/**' }, { path: 'Spawn*' }] })
tuner.open({ scratchpad: 'water-shader', scene: true })   // the scene Tuner moves to a scratchpad: its name, id or folder
tuner.open({ scratchpad: null, scene: true })             // and back to the project's own editor
```

Any Tuner can open on the project or on a scratchpad, never on a multiplayer clone. Opening it on another target moves the user's open Tuner of that kind (the scene Tuner, or that prefab's Tuner) to the new target in the same tab. A new tab opens only when no Tuner of that kind is open. If that editor is still starting, `tuner.open` throws right away and says what state it's in. `{ wait: 300 }` opens the Tuner and waits up to 300 s for the editor. `{ wait: false }` opens it and returns. A stopped scratchpad throws unless `wait` is false, so start it with `scratchpad.start()` first. A scratchpad that failed to start always throws.

Prefer a scene, a ui root or `children: true` over long lists. The reply lists paths that didn't resolve: fix them first.

## Filters

```js
{ path: 'Hero' }                                            // every component
{ path: 'Hero', components: ['Transform', 'Rigidbody'] }
{ path: 'Hero', exclude: ['Animator', 'AudioSource#1'] }    // #1 = the second AudioSource
{ path: 'Hero', components: [] }                            // header only
{ path: 'Hero', components: [{ type: 'Rigidbody', fields: ['mass', 'useGravity'] }] }   // drops a custom editor
{ path: 'Hero', components: [{ type: 'Enemy', exclude: ['settings.speed'] }] }          // keeps it
assets: ['Assets/Config/Waves.asset', { path: 'Assets/Mat.mat', label: 'Water', fields: ['_BaseColor'] }]
```

Serialized names, `m_` optional, nested like `'waves.Array.data[2]'`. A wrong name in `exclude` hides nothing, silently. With wildcards, `components` also drops objects missing any of them.

The scene view of a filtered Tuner draws the filtered objects and what stands within a few metres of them (a small prefab instance counts as one piece) with their own materials, and leaves the rest out. The eye button in the filter bar, `Show the whole scene`, draws everything as Unity does; `Hide objects far from the filter` goes back. A hierarchy search (`tuner.search`) does the same around its results. A filter that holds a Light always draws the whole scene.

## Options

```js
tuner.open({
  scene: true, name: 'spawns', merge: true, title: 'Spawns', mode: '3d',
  camera: { position: [0, 12, -10], lookAt: [0, 0, 0] },
  select: 'Arena/Spawn', frame: true, open: false,
  animator: { path: 'Hero', clip: 'Run' },
  buttons: [
    { label: 'Reset waves', type: 'WaveSpawner', method: 'ResetAll', mode: 'play', tip: 'Restart from wave 1' },
    { label: 'Bake', path: 'Arena', component: 'NavBaker', method: 'Bake', step: 1 },
    { label: 'Validate', asset: 'Assets/Config/Waves.asset', method: 'Validate', step: 2 }
  ],
  states: [{
    name: 'jump-apex', label: 'Apex', note: 'Arm pose at the top', objects: [{ path: 'Hero' }],
    camera: { position: [2, 2, -3], lookAt: [0, 1, 0] },
    setup: [
      { animate: { path: 'Hero', state: 'Jump', layer: 0, time: 0.5 } },
      { animate: { path: 'Hero', clip: 'Jump', seconds: 0.4 } },
      { call: { type: 'Game', method: 'Freeze' } },
      { set: { path: 'Hero', component: 'Rigidbody', field: 'isKinematic', value: true } },
      { pause: true }
    ]
  }]
})
```

The same `name` replaces a view, `merge: true` adds to it. Buttons call a parameterless method and show what it returned; `step` numbers unlock in order. States are Play Mode moments (1 to 16, switched with [ and ]); leaving one undoes its edits. Sprites, tilemaps, uGUI and TMP draw as in Unity and switch the view to 2D.

## Driving it

These go through the Tuner's real UI, so Undo, Save and Discard behave as for the user. With several open, they use the one you opened or `tuner.use('scene' | prefabPath | name)`. Paths are full from the scene root, or from the prefab root ('Crate/Lid'); same-name siblings take `[2]`. When the user asked from a Tuner, it's already open.

```js
await tuner.open({ scene: true })
await tuner.row('Level/Player').click()
await tuner.handle('Level/Player', 'y', 'move').drag(0, -60)
await tuner.field('Mass', { section: 'Rigidbody' }).set(2)
return { selected: await tuner.selected(), position: await tuner.field('Position').value() }
```

```js
await tuner.focus('Level/Player', { angle: 'three-quarter', distance: 4 })   // 'auto' | 'front' | 'top' | { yaw, pitch }
await tuner.inspect('Level/Player', { component: 'Rigidbody', fields: ['m_Mass'] })   // what the user sees: the filter name, and shown/total per filtered component
await tuner.search('Cart'); await tuner.select(['A', 'B']); await tuner.object('Level/Player')
await tuner.canvasView('HUD')                 // one overlay canvas alone; no arg reads options, 'Scene' goes back
await tuner.component('Rigidbody', { index: 0 }).menu('Reset')   // remove(), enabled(false), expand(false)
await tuner.addComponent('BoxCollider')
await tuner.button('Add Override').pick('Bloom')
await tuner.undo(); await tuner.redo()
await tuner.save(); await tuner.discard()     // only when the user asks
await tuner.camera.frame('Level/Player'); await tuner.camera.view('front')
await tuner.camera.orbit(30, 10); await tuner.camera.zoom(2); await tuner.camera.set({ yaw, pitch, distance, target }); await tuner.camera.get()
await tuner.timeline.seek(30); await tuner.timeline.step(1); await tuner.timeline.playhead()
await tuner.timeline.showAll(); await tuner.timeline.key(30, { row: 'position.y' }).click()
```

`tuner.field(label | propertyPath, { section })` values:

```js
.set(3) .set('Hero') .set({ x: 0, y: 1, z: 0 }) .set(true) .set('Forward')     // dropdown label
.set('#FF8800') .set('Level/Target') .set('Assets/Mats/Red.mat') .set(null)
.set('Water') .set(['Default', 'Water'])                                         // mask: toggle / set
.set([{ time: 0, value: 0 }, { time: 1, value: 1 }])                            // curve
.set({ limit: -25 })                                                             // struct, one undo step
tuner.field('Position').x  /  tuner.field('Position.x')
tuner.field('Bloom').set(true); tuner.field('Bloom Intensity').set(0.6)          // URP override
.value() .expand() .menu('Revert') .scrub(20)
```

Trackballs take `{ x, y, z, w }`. HDR colour into a non-HDR field is clamped. Labels match the drawn inspector once a component has been drawn, the serialized name before that. Every Tuner target has `click()`, `hover()`, `drag(dx, dy)`, `dragTo(target)`, `wheel(dx, dy)`, `box()`. Panes: `tuner.hierarchy`, `tuner.inspector`, `tuner.viewport`.
