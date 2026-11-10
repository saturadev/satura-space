# The app from a script

## Parts

| Part | Target |
|---|---|
| Sidebar: workspaces, agents, files | `ui:sidebar`, `ui:files` |
| Tabs: every terminal, game, Tuner, viewer; drag to a panel middle to join, edge to split | `page.getByRole('tab', { name })` |
| New session (+): agent, Unity Player, Console, Tuner, Scratchpads, Reports, Git, terminal | `ui:new-session` |
| Unity Player: the live game, Play (Ctrl/Cmd+P), pause, step, add players | `ui:player`, `ui:play`, `ui:pause`, `ui:add-player` |
| Refresh / relaunch | `ui:refresh` |
| Unity Console | `ui:console` |
| Git: changes, commit, history; Env Changes holds never-commit files | tab "Git" |
| Tuner | `ui:tuner` |
| Hierarchy and search | `ui:hierarchy`, `ui:search` |
| Scene view and toolbar | `ui:scene`, `ui:toolbar`, `ui:move`, `ui:rotate`, `ui:scale`, `ui:frame`, `ui:lighting`, `ui:grid`, `ui:camera`, `ui:gizmos`, `ui:effects`, `ui:animation` |
| Inspector, timeline | `ui:inspector`, `ui:timeline` |
| Filter bar, Save, Discard, Copy Changes | `ui:filter`, `ui:save`, `ui:discard`, `ui:copy-changes` |
| Ask Drift (shortcut /) | `ui:ask-drift` |

## page

Playwright's API on your workspace. Input goes to the window without moving the user's cursor.

```js
const tabs = page.locator('[data-tabbar-tab]')
const before = await tabs.count()
await page.getByRole('button', { name: 'New session' }).first().click()
await page.getByRole('button', { name: 'Open terminal' }).click()
await tabs.nth(before).waitFor()
return { before, after: await tabs.count() }
```

```js
await snapshot(page.getByRole('tablist').first(), { depth: 4, max: 4000 })   // - button "New session" [ref=e9]
await page.locator('aria-ref=e9').click()
await page.evaluate(() => window.api)                                  // the app's bridge
```

- Icon buttons are named by their tooltip.
- A click that finished only happened. Prove the effect with `waitFor()`, a count or `snapshot()`; `shot()` is not proof.
- `snapshot()` caps at 8000 characters: scope it. It can't see the Tuner's inspector and scene view (use [tuner](tuner.md)) or the game (screenshots, video, handles).
- While the user works in your workspace the script pauses, uncounted. Check state again after.
- Once a script changes the UI, Drift appears and acts visibly. The reply's `Drift:` line says where it last pointed; `covered by` means something sat on top, `lost the target` means the element went away.

## Helpers

```js
await shot(page.getByRole('tablist').first())                 // image
await show(tuner.inspector)                           // size its pane
await point(target, 'This is the Play button', { ms: 2000, spotlight: true, camera: false })
await say('Done', { at: target, wait: true })
await ask('Keep it?', { buttons: ['Yes', 'No'], at: target })
await app.windows()
await logs.app({ lines: 100, grep: 'error' })
await logs.console({ lines: 50 })
await agents.status()
await agents.spawn({ prompt: 'Fix the bobber', placement: 'right' })     // 'tab' | 'right' | 'down'
await agents.send(id, 'Status?'); await agents.report('Built the cast'); await agents.close(id)
await sleep(500)
```

A target is a locator, a Tuner target or `{ x, y }`. In a Tuner, point, say and ask frame the subject with the scene camera unless `{ camera: false }`.

## Tabs and the phone

```js
await app.tabs()                               // [{ id, label, kind, pane, shown, focused, phone }] of this workspace
await app.switchTab('Unity Console')           // by id, label, kind ('tuner', 'console', 'agent') or a row of app.tabs()
await app.switchTab('Tuner', { phone: true })  // the user's phone shows it too, from whatever screen it is on
await app.phone()                              // { connected, device, visible, screen, tab, summary }
```

The phone (Satura Remote) shows one panel at a time. On this workspace it shows the tab the Mac focuses, so a plain `switchTab` moves it too; `{ phone: true }` also brings it there from its panel list, the file browser or another workspace. `screen` is `projects`, `layout` (the panel list), `panel` or `files`. A phone in the background shows the tab when it comes back.

## Env files

Files the user marked never-commit (local URLs, keys). Git doesn't know the list, so `git add -A` picks them up.

```js
await env.list()
await env.check(['Assets/Config/Server.json'])    // before git add or commit
await env.diff(paths)                             // what stage would add
await env.stage(paths)                            // stages only your new lines
await env.add(paths); await env.remove(paths); await env.keep(paths)   // only when the user asks
```
