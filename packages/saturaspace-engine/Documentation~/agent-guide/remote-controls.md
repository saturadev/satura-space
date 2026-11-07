# Phone controls

Satura Remote, the phone app, plays the game with on-screen controls built from the project's own Input
System setup, plus a trackpad for the mouse. Two JSON files in the project describe them. Neither goes
into git: Satura Space hides `ProjectSettings/SaturaRemote/` in `.git/info/exclude`.

| File | Who writes it |
|---|---|
| `ProjectSettings/SaturaRemote/controls.generated.json` | The editor, from the Input System assets, on every `.inputactions` import, scene or prefab import and editor load. Never edit it. |
| `ProjectSettings/SaturaRemote/controls.overrides.json` | You, and the phone's Edit layout. Optional. |

What the phone shows is the generated layout with the overrides applied. Overrides are keyed by action
id, so they survive regeneration; one that points at an action or binding that no longer exists is
reported as stale and does nothing. It is never deleted for you.

```js
await app.handle('remote.controls')                         // effective layout, files, issues
await app.handle('remote.controls', { full: true })         // plus both files and every field
await app.handle('remote.controls.validate', { overrides }) // check an object before you write it
await app.handle('remote.controls.validate')                // check the file on disk
await app.handle('remote.controls.regenerate')              // rewrite the generated file now
await app.handle('remote.controls.gamepadModule', { on: true })
```

Read `value.issues` after every change: `stale` (an id that is gone), `error` (a bad value, ignored)
and `warn` (applies, with a caveat). A stale override whose old `action` path now belongs to a new id
says so; move the override to the new key if it is the same action.

## How the layout is generated

Output is always keyboard and mouse: every control presses the keys or mouse buttons the action is
bound to, so the game sees the Satura keyboard and mouse.

- Maps: every map of every `.inputactions` asset under `Assets` and the project-wide actions. A map
  named `UI`, or one with Navigate, Submit and Point, is a UI map. The default map is the PlayerInput
  default map (open scenes, Build Settings scenes and the prefabs they use), else the first gameplay
  map. In Play Mode the phone shows the gameplay maps that are enabled right now, else the default map.
- Bindings: the control scheme with Keyboard (and Mouse) picks the bindings, or the PlayerInput default
  scheme when that one has them. Bindings outside it are a fallback. The first usable one is
  `binding`; the other keyboard and mouse ones are `alternatives`.
- Vector2 with a `2DVector` (or `Dpad`) composite on keys: a joystick that presses those keys,
  eight ways.
- Axis with a `1DAxis` composite on keys: a `−` / `+` rocker. Two axes that make a 2D move become one
  joystick on the X action that presses the keys of both: names `MoveX` / `MoveY` (any `<name>X` /
  `<name>Y`), `Horizontal` / `Vertical`, or keys `A`/`D` with `S`/`W` (or the arrows). The stick gets
  `label` (`Move`), and the Y action is hidden with `joined` set to the stick's id.
- Button, PassThrough and other value actions: a button for a key, a mouse button or `scroll/up`
  and `scroll/down`. `ButtonWithOneModifier` and `ButtonWithTwoModifiers` (and `OneModifier`,
  `TwoModifiers`) on keys press the whole chord.
- `<Mouse>/delta`, `scroll` and `position` (and `<Pointer>`): no button; the trackpad drives them
  (`kind: "pointer"`).
- Interactions: `Hold` or `SlowTap` alone give `behavior: "hold"` with `holdMs` from the duration
  (a ring fills while held). `Tap` alone gives `"tap"`, a short press whatever the finger does.
  `MultiTap` gives `"multiTap"` with `taps`. Both kinds, or none, give `"press"`: down while the
  finger is down.
- Actions bound only to a gamepad, touch, XR or other devices get `output: null` and `unavailable`
  saying why. A gamepad binding is kept as `gamepad` for the gamepad module.
- Hidden by default, with the reason in `hidden`: debug and dev actions (names or a map name with
  debug, console, cheat, developer, godmode, noclip, profiler, screenshot, showfps), voice chat (voice,
  push-to-talk, ptt, microphone), keys `` ` `` and `F1`–`F24`, a button that presses the same thing as
  an earlier one (`same key as Attack`) and a key button a stick or rocker already presses
  (`the Move stick presses S`). `"visible": true` in the overrides shows any of them.
- On screen by default per map: two sticks, two rockers and eight buttons of the rest, in the asset's
  order. Everything else is under More on the phone, where holding a row presses it.

```json
{
  "id": "7da241a9-e887-42b5-9823-59b5ceb23784",
  "action": "Fire",
  "path": "FPS/Player/Fire",
  "actionType": "Button",
  "controlType": "",
  "kind": "button",
  "visible": true,
  "binding": "5b0c…",
  "bindingText": "Left Button [Mouse]",
  "output": { "type": "mouse", "button": 0 },
  "behavior": "hold",
  "holdMs": 400,
  "interactions": "Hold(duration=0.4)",
  "alternatives": [],
  "gamepad": { "type": "gamepad", "trigger": "right" },
  "gamepadBinding": "e1f2…"
}
```

`label`, `hidden` and `joined` appear only when they apply:

```json
{ "action": "MoveX", "kind": "stick", "label": "Move", "output": { "type": "keys", "up": "W", "down": "S", "left": "A", "right": "D" } }
{ "action": "MoveY", "kind": "axis", "visible": false, "hidden": "joined into the Move stick", "joined": "c026d806-…" }
{ "action": "ToggleConsole", "visible": false, "hidden": "debug action" }
```

## Overrides

```json
{
  "format": "satura-remote-overrides",
  "version": 1,
  "defaultMap": "Player",
  "drive": "keyboard",
  "trackpad": { "speed": 1.2, "lookSpeed": 1, "acceleration": 1, "invertY": false, "naturalScroll": true },
  "controls": {
    "bf3c1731-419b-4b02-85af-48b89193172e": { "action": "FPS/Player/Move", "binding": "a237d990-2bd8-4f90-857c-7d1888ca4619" },
    "075be21f-c2f6-468f-8276-c29aa1d6ce40": { "action": "FPS/Player/Sprint", "behavior": "toggle" },
    "b3e7bcae-f696-4f2f-8f9a-7283ca4e9362": { "action": "FPS/Player/Jump", "label": "Hop", "portrait": { "x": 0.65, "y": 0.64, "size": 1.3 } },
    "966f1242-2b91-405d-aa43-19540b10dc5c": { "action": "FPS/Player/Pause", "visible": false }
  },
  "extra": [
    { "id": "menu", "map": "Player", "label": "Menu", "output": { "type": "key", "key": "Escape" } }
  ]
}
```

- `controls` keys are action ids from the generated file. Put the action's `path` in `action`: it
  only labels the override and finds the action again if it is recreated.
- Per control: `visible`, `label` (1–40 characters), `behavior` (`press`, `hold`, `toggle`, `tap`,
  `multiTap`), `holdMs`, `taps`, `binding` (an id from `binding` or `alternatives`), `output`,
  `drive` (`keyboard` or `gamepad`), and `landscape` / `portrait` placements.
- Placement: `x` and `y` from 0 to 1 are the control's center in the controls area (in landscape the
  game picture and its side bars, in portrait the area under the picture), `size` from 0.4 to 3.
  Without one the phone lays the control out itself. Placed controls go first, in the asset's order;
  one that would overlap an earlier one or the edge moves to the nearest free spot, so a layout never
  overlaps, and controls that don't fit at all go under More.
- `output` types: `key` (`key`), `chord` (`keys`, 2 or 3), `keys` (`up`/`down`/`left`/`right` for a
  stick, `negative`/`positive` for a rocker), `mouse` (`button` 0–4), `wheel` (`dir` 1 or -1),
  `mouseDelta`, `mousePosition`, `scroll`, and with the gamepad module `gamepad` (`stick`: `left`,
  `right`, `dpad`; `button`: `buttonSouth`, `buttonEast`, `buttonWest`, `buttonNorth`, `leftShoulder`,
  `rightShoulder`, `start`, `select`, `leftStickPress`, `rightStickPress`, `dpadUp`…; `trigger`:
  `left`, `right`). Key names are the Input System `Key` names: `Space`, `W`, `LeftShift`, `Digit1`,
  `Escape`, `UpArrow`.
- `extra` adds controls no action has, like a menu key the game reads some other way. `map` is a map
  name or id, or `*` for all.
- The phone's Edit layout writes `visible`, `behavior`, `drive`, `landscape` and `portrait` into the
  same file and leaves everything else alone.

## Gamepad module

Keyboard and mouse is the default. For true analog sticks, triggers and gamepad buttons the project
needs the Satura Remote gamepad module: the engine's `SaturaSpace.Sdk.RemoteGamepad` assembly,
compiled only with the scripting define `SATURA_REMOTE_GAMEPAD`. It registers
a `SaturaRemoteGamepad` device that the phone drives; the device appears on the first gamepad input
from the phone, so a game that switches control schemes or button prompts on a new gamepad will do
so. Ask the user before turning it on.

```js
await app.handle('remote.controls.gamepadModule', { on: true })  // Standalone and the active target
await unity.refresh()                                            // waits for the recompile
await app.handle('remote.controls')                              // gamepadModule: true
```

Then set `"drive": "gamepad"` on a control (or at the top for every control with a gamepad binding).
Without the module the control stays on keyboard and mouse and `issues` says why; a control with no
keyboard or mouse binding stays hidden. The define lives in `ProjectSettings/ProjectSettings.asset`,
which Unity writes when the project is saved. Without Satura Space the define does nothing.

## The phone

- Portrait: the picture on top, centered between the header and the top of the controls; landscape:
  the controls sit translucent over the picture. App chrome never covers the picture: the Stream and
  input, Edit layout and More buttons are small round icons under the picture (portrait) or in the side
  bar next to it (landscape, a 40 px column when the picture fills the width).
- Layout: the first stick bottom left, a second one bottom right, rockers stacked above the first stick,
  buttons in a fan from the bottom right corner: the first button bigger in the corner, then rings
  around it with even spacing. What doesn't fit goes under More. Labels drop leading words such as
  Toggle and Use, wrap to two lines and shrink before they would be cut; the key is under them.
- Edit layout: drag a control to move it, pinch it (or put one finger on it and one beside it) to
  resize it from 0.7 to 2 in steps. Neighbors that the phone placed move out of the way, placed ones
  limit the size; a dropped control that lands on a placed one pushes it aside and both positions are
  saved.
- Edit Mode: the picture area shows the last frame or a placeholder with a Play button that enters
  Play Mode, and the controls show dimmed so the screen looks the same as in play.
- Trackpad, everywhere a control isn't: drag moves the mouse with acceleration (look when the cursor is
  locked), tap is a left click, two-finger tap a right click, three-finger tap a middle click,
  two-finger drag scrolls, press and hold or double-tap and drag drags. Dragging off a held button
  also looks, for firing while aiming.
- `app.handle('remote.gameInput')` reads the phone's input link on the Mac.
