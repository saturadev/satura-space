# Free Assets

CC0 models, materials and HDRIs from Poly Haven and ambientCG, pulled into the project with materials built for its render pipeline (URP or Built-in; HDRP is refused). Use them when a prototype needs real-looking props, ground, walls or sky instead of primitives.

```js
const found = await assets.search('wooden crate', { kind: 'model', source: 'polyhaven', limit: 10 })
// [{ id: 'polyhaven:wooden_crate_02', name, kind, tags, thumbnail, source, license: 'CC0', credit, url, imported? }]
const r = await assets.import('polyhaven:wooden_crate_02', { res: '1k' })
// { kind: 'model', prefab, path, tris, size: [x, y, z], materials, pipeline, files, bytes }
await assets.import('ambientcg:Ground054', { res: '2k' })                       // { kind: 'material', material, path }
await assets.import('polyhaven:kloofendal_48d_partly_cloudy', { skybox: true })   // { kind: 'hdri', skybox, scene }
await assets.list()                                                              // [{ id, name, kind, path, source }] already in the project
```

- `search(query, options)`: words match names and tags; an empty query lists the most downloaded. `kind` is `'model'`, `'material'` or `'hdri'`, `source` `'polyhaven'` or `'ambientcg'`; leave either out for all. `limit` up to 200, `offset` pages. The index is cached for a day, so searching is free.
- `import(id, options)`: `res` is `'1k'` (default), `'2k'`, `'4k'` or `'8k'`; the nearest one a file has is used. Unity must be running. Files land in `Assets/ThirdParty/PolyHaven/<id>/` or `Assets/ThirdParty/ambientCG/<id>/`, and a credit line goes into `Assets/ThirdParty/CREDITS.md`. Importing again rebuilds the same assets.
- A model comes back as a prefab with its materials: drop it in with `PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(r.prefab))` in `unity.exec`. Its root has no rotation or scale and its base sits at y = 0, so move, turn and scale the root. `size` is its bounds in metres; scale it to the game.
- A material is a `.mat` to put on renderers or terrain layers. Tile it with `mainTextureScale`.
- An HDRI is a Panoramic skybox material. `skybox: true` also sets it on the open scene and refreshes ambient light; the scene is left unsaved.
- Ask before importing at `4k` or `8k`: those downloads are tens to hundreds of MB.
- Tell the user where an asset came from when you use it; the panel (New session → Plugins → Free Assets) shows the same library with thumbnails.
