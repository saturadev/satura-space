# Playables

Turns a Unity scene into a playable ad: one HTML file that ad networks accept, with the real game logic and no Unity runtime inside. The editor exports the scene, prefabs, animations and assets; a small JS runtime (about 130 KB) re-implements the part of the UnityEngine API games use; you write each gameplay script once more in JS, 1:1, with the same class, method and field names; the plugin packs it, shrinks it to the budget, proves it plays like Unity with a seeded run and wraps it for every ad network.

There is no C# to JS transpiler. You write the JS yourself, script by script, and the verify run against the editor is your feedback loop.

```js
await playables.init({ scene: 'Assets/Scenes/Main.unity', name: 'my-game' })   // Playable/ layout, never overwrites
await playables.scan('Assets/Scenes/Main.unity')    // scripts, components, input module, assets with bytes
await playables.export()                            // Playable/build/ from the open editor
await playables.pack()                              // Playable/out/<name>.html + report.json
await playables.size()                              // where the bytes go, what to shrink
await playables.verify('verify/main.json')          // HTML vs Unity, same seed, same input
await playables.preview({ at: '0.5,3,8', script: 'verify/main.json' })   // screenshots on the game clock
await playables.networks()                          // one variant per ad network, each checked
```

Set the satura_exec `timeout` to 600 for `export`, `verify` with Unity and `networks`. Every call is also an app handle (`playables.export`, `playables.verify`, ...).

## 1. Pick the slice

A playable is 15 to 30 seconds of the best part of the game. Before writing code:

- `playables.scan()` lists the scenes; `playables.scan(scene)` lists the scripts the scene needs with their line counts, every component type with its count, the input module and the assets with bytes. Choose one scene (or two: a level and what loads after it).
- Decide where it ends: a win, a loss, N moves (`endCard.afterMoves` in your hook), or N seconds (`endCard.afterSeconds`). The end card with the CTA covers the game then.
- Cut what the slice doesn't reach: menus, level select, settings, IAP, analytics, ads SDKs, save systems. A scene that is not in `scenes` is never exported; when the game loads it, the end card shows instead.
- Portrait 9:16 is the default stage. If the game is landscape, keep its scene and scripts and move things with `overrides` (below).

## 2. The layout

```
Playable/
  playable.json        the config (below)
  game/main.js         entry: registerTypes(GameTypes), hooks, Playable.boot()
  game/index.js        GameTypes: { 'Namespace.ClassName': JsClass } for every script in the scene
  game/<Script>.js     one JS module per C# script, same names
  game/MAPPING.md      one row per script: anything you did beyond the standard rules
  verify/<name>.json   seeded input scripts for playables.verify
  fonts/, ...          files the config points at (fontFiles)
  build/ out/ verify/runs/   generated, gitignored
.sspace/playables/runtime/   read-only copy of the runtime source: read it to see what exists
```

Import the runtime as `import { MonoBehaviour, Vector3, Alive } from 'playables';` and your own files by relative path. Everything is packed into one scope: top-level names must be unique across all files, one import per line, `export` only on declarations.

## 3. Write each script in JS, 1:1

Open the C# file and write the JS next to it with the same class, method, field and property names. The exporter writes every serialized field under its C# name, the runtime assigns it on the instance, and Unity's message methods (`Awake`, `OnEnable`, `Start`, `Update`, `LateUpdate`, `OnDisable`, `OnDestroy`, `OnPointerDown`, ...) are called by name.

| C# | JS |
|---|---|
| `class Foo : MonoBehaviour` | `export class Foo extends MonoBehaviour` and `'Ns.Foo': Foo` in `index.js` |
| `[SerializeField] private float speed = 2f;` | `speed = 2;` (class field with the C# default) |
| `private`/`public`, `readonly`, attributes | dropped, same names |
| property with logic | `get X() {}` / `set X(v) {}` |
| auto-property `{ get; private set; }` | plain field |
| `IEnumerator Run()` + `yield return new WaitForSeconds(1)` | `*Run()` + `yield new WaitForSeconds(1)`; `StartCoroutine(this.Run())` |
| `GetComponent<T>()`, `FindObjectOfType<T>()` | `GetComponent(T)`, `FindObjectOfType(T)` |
| `if (obj)`, `obj == null` on a Unity object | `Alive(obj)`, `!Alive(obj)`: destroyed objects are not null in JS |
| `List<T>` | array (`Add` `push`, `Count` `length`, `Remove` splice, `Clear()` `length = 0`) |
| `Dictionary<K,V>` | `Map` |
| `T[,]` | `Array2D(w, h)`, `a[x][y]` |
| `enum` | frozen object with the same names and numbers |
| `(int)f`, integer division | `CsInt(f)`, `CsInt(a / b)` |
| `Random.Range(int, int)` / `Random.Range(float, float)` | `Random.Range(a, b)` / `Random.RangeFloat(a, b)`: same Xorshift128 as Unity |
| `Vector3` math (`a + b`, `a * 2`) | `a.add(b)`, `a.mul(2)`; vectors are copied on get and set like structs |
| `Mathf`, `Time`, `Debug`, `PlayerPrefs` | same names |
| `event Action`, `UnityEvent` | array of callbacks / `UnityEvent` (`AddListener`, `Invoke`) |
| `string.Format`, `$"..."` | template strings; `ToString("0")` by hand |
| C# overloads | one method that checks its arguments |
| `static` members | `static` members |
| comments | none |

Write down every deviation in `game/MAPPING.md`. Read the C# you translate completely; small differences (a loop bound, an integer cast, an `else`) are exactly what the verify run catches later.

Anything the runtime lacks for your game, add in `game/`: a class registered in `GameTypes` under the Unity type name replaces a missing built-in component (`'UnityEngine.Rigidbody2D': MyRigidbody2D`), and you can extend runtime classes from your own module. The console warns once per component type it doesn't know.

Ad wiring lives in your own `game/hooks.js`, never in the translated scripts: wrap a method to schedule the end card.

```js
import { Ad } from 'playables';
import { GameOver } from './GameOver.js';
const show = GameOver.prototype.ShowWin;
GameOver.prototype.ShowWin = function (...a) { const r = show.apply(this, a); Ad.scheduleEndCard(2, { title: 'You win!', score: a[0] }); return r; };
```

## 4. Export and pack

`playables.export()` runs in the project's editor (it must be open and not playing). It walks every GameObject of the listed scenes, dumps every component through `SerializedObject`, follows references into prefabs, animation clips, animator controllers, fonts, ScriptableObjects (as `objects`) and the mesh, material, texture and audio tables, and packs every referenced sprite into atlases. Only what the scenes reference is exported. Read the `warnings`.

`playables.pack()` bundles the runtime and your `game/`, encodes every exported file (atlases and textures to WebP, audio to a low bitrate, meshes reduced), inlines everything into `Playable/out/<name>.html` and writes `Playable/out/report.json`. Open the HTML from disk in any browser; `?seed=N` fixes `Random.InitState`.

## 5. Fit the budget

Ad networks cap the file at 5 MB (Meta at 2 MB, ironSource at 4 MB); aim well under. `playables.size()` lists every packed part with raw and packed bytes, bytes per source asset and hints. Turn these down, biggest first:

| Key in `playable.json` | What it does |
|---|---|
| `spriteScale`, `spriteScales: [{ path, scale }]` | resamples sprite textures before atlasing (area filter), world sizes stay the same; a folder path matches everything under it |
| `atlasMaxSize`, `atlasPadding` | atlas page size and padding |
| `webpQuality` | WebP quality for atlases (0 keeps PNG) |
| `textures: { maxSize, quality }` | non-sprite textures (materials): downscale to maxSize, WebP |
| `meshes: { decimate, minTriangles }` | mesh reduction ratio (quadric edge collapse) for 3D meshes |
| `audio: { bitrate, maxSeconds, mono, sampleRate }` | audio is trimmed and re-encoded |
| `fontFiles: { "<font name>": "fonts/x.woff2" }` | ship a subset woff2 instead of the TTF |
| `skipComponents: ["Full.Type.Name"]` | leave components out of the export (analytics, ads SDKs, debug tools) |
| `extraSprites`, `extraAssets` | assets the scenes don't reference that your JS loads (an end-card logo) |

## 6. Verify against Unity

`Playable/verify/<name>.json` is a seeded input script. Unity plays it in play mode in the project's editor with `Time.captureDeltaTime` at 1/60 and the scene's EventSystem driven by a scripted pointer; the HTML plays it in a hidden page on the same fixed step. After every step both sides wait until the settle condition holds, then snapshot the probes; the snapshots are compared.

```json
{
  "settle": { "type": "Ns.Board", "member": "IsBusy", "equals": "false", "frames": 2 },
  "settleMax": 900, "finalWait": 360, "deadline": 600,
  "probes": [
    { "type": "Ns.Piece", "members": ["X", "Y", "Kind", "Color.Value"] },
    { "type": "Ns.Level", "members": ["score", "_movesLeft"] },
    { "type": "UnityEngine.UI.Text", "members": ["text"] },
    { "type": "Ns.GameOver", "members": ["panel.activeSelf"], "inactive": true }
  ],
  "runs": [
    { "scene": "Main", "seed": 7, "steps": [
      { "kind": "drag", "from": [-2.5, 3, 0], "to": [-1.5, 3, 0], "frames": 8 },
      { "kind": "tap", "target": "Canvas/Panel/Retry" },
      { "kind": "hold", "from": [0, 0, 0], "frames": 30 },
      { "kind": "wait", "frames": 120 }
    ] }
  ]
}
```

- Steps: `tap`, `drag`, `hold`, `move`, `wait`. `from`/`to` are world positions (aim at collider centres); `target` is a hierarchy path, clicked at its centre. Before a press the pointer moves onto the spot for one frame, as a mouse would.
- Probes: every active component of `type` (with `inactive`, also inactive ones) becomes a row of its hierarchy path and the members, read by name through fields and properties (`a.b.c` walks references). Rows are sorted, so order doesn't matter. Numbers are rounded to 3 decimals and compared with a small tolerance; vectors become arrays, Unity objects their names.
- Settle: a member that says the game is idle (no animation, no falling pieces). Without it, every step snapshots on the next frame.
- `playables.verify(script)` runs the HTML side and the Unity side (the editor enters and leaves play mode on its own; the scene you have open stays). The Unity run is cached per script content: change only your JS and run again with the default `unity` to compare against the cached run in seconds. `unity: true` forces a new Unity run, `false` runs only the HTML.
- The result says `states`, `equal`, `rngEqual`, the frame of every snapshot on both sides and the first mismatches as the differing rows. Fix your JS (or a runtime gap) until `equal === states`. A timing difference shows in the frames; a logic difference in the rows.
- Generate scripts with a small bot in your game JS or by hand; cover the moves the ad shows, rejected input and the end of the level.

What it can't drive: games that read `Input.*`, `Mouse.current` or `Touchscreen.current` directly instead of EventSystem handlers. Write a probe-able input seam in your hook for those, or verify them through their own state with `wait` steps.

## 7. Look at it

`playables.preview({ at: '0.5,3,8', size: '540x960', script: 'verify/main.json' })` steps the playable on the game clock (optionally playing a verify script) and saves screenshots to `Playable/out/preview/`. Use them for the look only: layout, crop, the CTA, the end card. Proof that it works is `verify`.

## 8. Ad networks

`playables.networks()` packs and writes `Playable/out/networks/`: one variant per network in `networks` of the config, each with its CTA call and lifecycle, then checks size, external loads, the CTA call in the code and a run under a mock of the network API.

| Network | File | Limit | CTA | Notes |
|---|---|---|---|---|
| applovin | `<name>-applovin.html` | 5 MB | `mraid.open(url)` | MRAID 2.0, no store redirect on the first tap |
| unity | `<name>-unity.html` | 5 MB | `mraid.open(url)` | MRAID 3.0 injected, starts on viewable |
| ironsource | `<name>-ironsource.html` | 4 MB | `mraid.open(url)` | MRAID 2.0, waits for ready, no DAPI |
| mintegral | `<name>-mintegral.zip` | 5 MB | `window.install()` | `gameReady()`, waits for `gameStart()`, `gameEnd()` once at the end card |
| google | `<name>-google.zip` (`index.html`) | 5 MB | `ExitApi.exit()` | `exitapi.js` and `ad.orientation` in the head |
| meta | `<name>-meta.html` | 2 MB | `FbPlayableAd.onCTAClick()` | no requests at all |
| tiktok | `<name>-tiktok.zip` (`index.html`, `config.json`) | 5 MB | `window.openAppStore()` | no mraid.js, no requests |

Set `storeUrl: { ios, android }` (or `cta.url`) before shipping. The CTA never fires on its own: the button and the end card's button call it on a tap.

## Config reference

| Key | Meaning |
|---|---|
| `name`, `title` | file name (lowercase, dashes) and page title |
| `scenes`, `startScene` | scene assets to export, scene name to start in |
| `entry` | JS entry, default `game/main.js` |
| `stage` | `width`:`height` aspect, `maxPixelHeight` of the canvas, `background` letterbox colour |
| `overrides` | `[{ path, component, set, scene? }]`: after load, assign fields on a scene object (portrait layout: camera size, HUD anchors) without touching scene or scripts |
| `clipOverrides` | `[{ clip, path, prop, scale }]`: scale one curve of an exported animation clip |
| `cta` | `label`, `url`, `bottom` (% of the stage) |
| `hint` | first-screen hint `text`, `bottom` |
| `endCard` | `winTitle`, `loseTitle`, `subtitle`, `playAgain`, `delayWin`, `delayLose`, `afterMoves`, `afterSeconds`, `logoSprite` |
| `seed` | fixed seed; omit for a random game |
| `budget` | bytes the pack warns above (default 5 000 000) |
| `networks`, `storeUrl` | variants to build, store links |

## What the runtime supports

- **Objects and lifecycle:** GameObject, Component, Behaviour, MonoBehaviour with Unity's order per frame (input, Start, Update, Invoke, coroutines, Animator, LateUpdate, end of frame, destroy); Instantiate (deep clone with reference remapping), Destroy with delay, DontDestroyOnLoad, Find, tags, layers, SendMessage.
- **Coroutines:** generators with `null`, WaitForSeconds, WaitForSecondsRealtime, WaitForEndOfFrame, WaitUntil, WaitWhile, nested; Invoke, InvokeRepeating.
- **Math:** Vector2/3/4, Quaternion, Color, Rect, Mathf, Random (bit-exact with Unity), Time, Screen, PlayerPrefs (in memory).
- **2D:** SpriteRenderer (tint, flip, sorting layers and order), orthographic Camera, BoxCollider2D and CircleCollider2D for picking, atlased sprites.
- **uGUI:** Canvas (overlay), CanvasScaler, CanvasGroup, Image (simple, sliced, preserve aspect), Text (font, size, style, alignment, wrap, best fit), Button, EventSystem with GraphicRaycaster and Physics2DRaycaster and the pointer handlers (down, up, enter, exit, click, drag).
- **Animation:** Animator with one layer, states, exit-time transitions, animation events; float and sprite curves.
- **Scenes and assets:** SceneManager.LoadScene, sceneLoaded; ScriptableObject assets (fields assigned by name); `Assets.file(name)` / `Assets.bytes(name)` for exported files.
- **Ad layer:** portrait letterbox, CTA button, hint, end card, MRAID and the network APIs above, all animated on the game clock.

The 3D and audio parts of the runtime are documented in the sections the mesh and audio exporters add below.

## Not supported

Physics simulation (rigidbodies, collisions, triggers: colliders exist for pointer picking), particles, tilemaps, masks, LineRenderer and TrailRenderer, video, TextMeshPro, layout groups, ScrollRect, Slider, Toggle, InputField, world-space canvases, Animator blend trees, layers, parameters and crossfades, `Input.*` and Input System actions read directly by scripts, `FixedUpdate`, `OnGUI`, `Resources.Load`, Addressables, async/await, threads, networking. Replace what your slice needs in `game/` and say so in `MAPPING.md`.
