# Dashboard

One per project: a grid of live tiles next to the game (server numbers, crash rate, build status, a handle's value). Build it with your file tools.

```
.sspace/dashboard/
  dashboard.json      { "title", "pages": [{ "id", "title", "tiles": [{ "widget", "x", "y", "w", "h" }] }] }   12 columns, 40 px rows
  widgets/<id>.tsx    one tile; can sit on several pages
  secrets.json        { "name": "value" } -> {{secret:name}} in useFetch url, headers, body
  alerts/<id>.ts      background checks that message an agent
```

## Widget

```tsx
import { useFetch, useSeries, Stat, Chart } from '@satura/dashboard'

export const title = 'Error rate'

export default function Widget() {
  const r = useFetch('https://api.example.com/game/stats', { every: 30, headers: { Authorization: 'Bearer {{secret:backend}}' } })
  const rate = r.data?.rate ?? 0
  const points = useSeries('rate', rate, { keep: 600 })
  return <><Stat label="Error rate" value={rate} tone={rate > 0.02 ? 'error' : 'ok'} /><Chart series={[{ name: 'rate', points }]} /></>
}
```

Imports only from 'react' and '@satura/dashboard' (the report kit plus hooks). No fetch, window or document.

```
useFetch(url, { every?, method?, headers?, body?, as? }) -> { data, error, loading, status, at, refresh }   every >= 2 s; 5 MB, 20 s
useSeries(key, value, { keep? }) -> number[]          kept while the panel is open
useStore(key, initial) -> [value, set]                saved to state.json
useHandle(name, args?, { every? }) -> { value, logs, error, loading, at, refresh }   primary editor
useGit({ log?, status?, every? }) / useLogs({ source: 'unity' | 'app', grep?, tail?, every? }) / useFile(path, { as? })
```

## Alert

Runs in the app while the project is open. When `when` goes from null to text, the message and a data snapshot go to the agent that last opened the dashboard (`to: 'new'` starts one). Sources: fetch, handle, git, logs.

```ts
import { alert } from '@satura/dashboard/alert'

export default alert({
  every: 60,
  fetch: { url: 'https://api.example.com/game/stats', headers: { Authorization: 'Bearer {{secret:backend}}' } },
  when: (d) => (d.rate > 0.02 ? `Error rate ${d.rate}` : null),
  cooldown: 600
})
```

## From a script

```js
await dashboard.open('live')                       // per-widget errors and alert states
await dashboard.read({ page: 'live', widget: 'ccu' })   // accessibility tree, hook states, errors; secrets masked
await dashboard.tile('ccu').getByRole('button', { name: 'Refresh' }).click()
```

Tiles reload when their file changes. The user drags and resizes tiles and the app writes x, y, w, h back. Secrets live in secrets.json only.
