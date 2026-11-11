# Plugins

A project plugin is a tool for this project: a panel in the app, functions for your scripts, or both. It lives in the project, stays out of git (`.sspace/` is excluded), and the app picks up every save without a restart. Build it with your file tools.

```
.sspace/plugins/<name>/        name: lowercase letters, digits and dashes, like scene-stats
  plugin.json    { "title": "Scene stats", "description": "Objects and triangles in the open scene" }
  panel.tsx      optional: one panel, New session → Plugins → This project
  exec.ts        optional: exported functions, called as plugins['<name>'].<fn>() in satura_exec
  agent.md       optional: notes for the next agent
```

A plugin named like a built-in one (`assets`) or like `list`, `open` or `read` is listed but not loaded. Unity code needs no plugin part: put C# in `Assets/` and give it a `[SaturaHandle]` (see [handles](handles.md)).

## Panel

The same kit and sandbox as a dashboard widget (see [dashboard](dashboard.md)): imports only from 'react' and '@satura/dashboard', no fetch, window or document, `useFetch` with `{{secret:name}}` from `.sspace/dashboard/secrets.json`, `useHandle`, `useGit`, `useLogs`, `useFile`, `useStore`, `useSeries`. `export const title` names the tab.

```
useExec(fn) -> { run(...args), value, error, running, at }   calls fn from this plugin's exec.ts
```

`run` works from a click only, like `<Action>`, and runs without an agent, so app calls work there but `unity.*`, `handles.*` and `video.*` don't. Read Unity in the panel with `useHandle`.

## exec.ts

Plain TypeScript with no imports. Each exported function runs inside the calling satura_exec script with its globals (`unity`, `handles`, `page`, `app`, `logs`, ...), never in Node: no `require`, `process` or `fetch`. A file that doesn't compile or throws while loading breaks only that plugin's calls, with the error in the message.

## From a script

```js
await plugins.list()                  // built-in and project plugins, their functions and errors
await plugins.open('scene-stats')     // opens the panel: { status, errors: { panel?, exec?, plugin? } }
await plugins.read('scene-stats')     // accessibility tree, hook states, errors
await plugins['scene-stats'].stats()  // a function from exec.ts
```

Write, `plugins.open`, fix what `errors` says, repeat until it is empty. Then click through the panel with `page` and call the functions from a script.

## Example

```ts
// .sspace/plugins/scene-stats/exec.ts
export async function stats() {
  const out = await unity.exec(`
    long tris = 0;
    foreach (var f in FindObjectsByType<MeshFilter>(FindObjectsSortMode.None)) if (f.sharedMesh) tris += f.sharedMesh.triangles.Length / 3;
    Print(FindObjectsByType<GameObject>(FindObjectsSortMode.None).Length + " " + tris);
  `)
  const [objects, tris] = String(out).trim().split(' ').map(Number)
  return { objects, tris }
}
```

```tsx
// .sspace/plugins/scene-stats/panel.tsx, reading a [SaturaHandle] SceneStats.Counts() that returns "objects tris"
import { useHandle, Grid, Stat } from '@satura/dashboard'

export const title = 'Scene stats'

export default function Panel() {
  const h = useHandle('SceneStats/Counts')
  const [objects, tris] = String(h.value ?? '').split(' ')
  return (
    <Grid min={140}>
      <Stat label="Objects" value={objects || '…'} />
      <Stat label="Triangles" value={tris || '…'} tone={Number(tris) > 1e6 ? 'warn' : undefined} />
      <button onClick={h.refresh}>Refresh</button>
    </Grid>
  )
}
```
