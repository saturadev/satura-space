# Drift

Drift is the app's guide. Use `drift.show`, `say` and `ask` only when the user asked a question, asked to be shown something, or used Ask Drift.

## Answering a question

Even "what's the monolith?" gets answered in the app. Change and save nothing.

```js
return await drift.look('Monolith')
```

```js
await drift.show('Monolith', 'The monolith is the level exit')
await drift.show('Monolith/ExitTrigger', 'ExitTrigger loads the next scene when you touch it')
await drift.show('Monolith/ExitTrigger.Delay', 'It waits 1.5 s first')
```

Then reply in a few sentences. Rules: one script of `look` (and read the scripts you'll talk about), one script of 2 to 6 `show` lines, one idea per line, real numbers with units. Don't guess.

## Targets

| Target | Example |
|---|---|
| a GameObject by name or path (shallowest wins, others listed) | `'Cart'`, `'Level/Props/Crate'` |
| the second same-name sibling | `'Lights/Room Light[2]'` |
| a component | `'Cart/Rigidbody'` |
| a field: inspector label, serialized name or label's last word | `'Cart/Rigidbody.mass'`, `'Player/PlayerController.Max Speed'` |
| the first field with that label | `'Directional Light.Intensity'` |
| an app part ([app](app.md)) | `'ui:hierarchy'`, `'ui:play'` |

A miss throws with the closest names.

## Verbs

```js
await drift.look()                       // selection + scene objects with components; draws nothing
await drift.look('Cart')                 // { path, components: [{ name, script, enabled, fields, more }], children }; selects it
await drift.look('Cart/Rigidbody')       // every field
await drift.look('Cart/Rigidbody.mass')  // { path, component, field, value }
await drift.look('ui')                   // panels on screen and what each app part does
await drift.show('Cart', ['First bubble', 'Second bubble'])   // { shown, value?, note?, alsoNamedLikeThis? }
await drift.say('A line where Drift floats')
await drift.ask('Ready?', ['Next'])      // the button clicked
await drift.click('ui:play')
await drift.type('ui:search', 'Cart')    // on a field it's a real edit
await drift.key('Escape'); await drift.key('ui:scene', 'F')
await drift.scroll('ui:inspector', 300)
```

`show` flies the camera to a visible object, points at the hierarchy row of an invisible one, opens and scrolls the inspector to a component or field, outlines an app part. `script` in `look` is the C# class: read its .cs before explaining it. Drift works in the Tuner in front first, or opens the scene Tuner.

## Common questions

```js
await drift.look('ui')                                                    // "what's this?" from a terminal
await drift.show('Directional Light/Light.Intensity', 'The sun is at 0.3')  // why is it dark
await drift.show('ui:effects', 'Turn fog and post-processing off here to compare')
await drift.show('ui:play', 'Press Play to run the game')                 // how do I play; don't press it
await drift.type('ui:search', 'Cart'); await drift.show('ui:search', 'Search lights up matches'); await drift.key('ui:search', 'Escape')
await drift.show('ui:timeline', 'The clip runs 2 s'); await tuner.timeline.seek(30)

for (const [target, line] of tour) await drift.show(target, line)
```

- "What's this?" from Ask Drift means the selection named in the message.
- Ask Drift from the phone says so in the message. Drift works in the Tuner on the Mac, and a phone that shows that workspace shows the same steps. `drift.look()` names the panel the phone shows; `app.switchTab(tab, { phone: true })` shows the user another one ([app](app.md)).
- "The tree" is `ui:hierarchy`, "the 3D view" `ui:scene`, "the fields" `ui:inspector`.
- Where's X: the player has the controller or input script, the camera has Camera, the sun is the Directional Light.
- Why is it dark: check Light and Volume objects and RenderSettings with `unity.exec`, then show the cause.

## Frame-exact captures

```js
await drift.clock('step')     // point() and say() return at once; Drift moves only on advance
await drift.advance(16)
await drift.clock('real')
```
