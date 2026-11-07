# Reports

At the end of every feature and for every failure, write `.sspace/reports/<name>/report.tsx` and open it in your terminal's tab. Keep the chat reply short and point to it.

```tsx
import { Report, Summary, Checks, Check, Video, BeforeAfter, Change } from '@satura/report'

export default function FishingReport() {
  return (
    <Report title="Fishing: bite and hook" status="partial">
      <Summary tone="warn">2 of 3 checks pass. A strike 0.4 s into the 0.6 s window doesn't hook.</Summary>
      <Checks>
        <Check name="WaitForBite(10)" status="pass" detail="Bit after 3.2 s" video="run" t={3.2} />
        <Check name="GetFishState" status="fail" detail="hooked=false, see FishBite.cs:91" video="run" t={3.9} />
      </Checks>
      <Video id="run" src="run.mp4" events={[{ t: 3.2, kind: 'ok', label: 'Bite' }]} />
      <BeforeAfter title="Tuning">
        <Change name="Bite delay" before={4.1} after={3.2} unit="s" better="lower" />
      </BeforeAfter>
    </Report>
  )
}
```

```js
await report.open('.sspace/reports/fishing-bite/report.tsx')       // type-checks, opens or reloads, lists missing media
await report.check(path)                                            // errors as path:line:column
await report.open(path, { exportHtml: true })                       // also one offline .html
await report.export(path, out)
```

- Import only from 'react' and '@satura/report'. Style with the `style` prop. No Tailwind, CSS files, `<style>`, `<script>`, `<iframe>`, dangerouslySetInnerHTML, window, document or fetch.
- Leave out the `session` prop; the app writes it.
- Media paths are relative to the report folder or absolute. Copy files in or point at .sspace/videos/.
- `Bite.cs:48` in text becomes a link. A video's id defaults to its src.
- Use BeforeAfter or DiffTable for before and after, not separate checks.
- Film the result so it's plain to see: [video](video.md).

## The kit

```
Tone = 'ok' | 'info' | 'warn' | 'error' | 'muted'
VideoEvent = { label, frame? | t?, kind? }      LogLine = { msg, level?, frame? | t?, src?, stack? }

Report title, subtitle?, status?: 'pass'|'fail'|'partial'|'info'      Summary tone?
Section title?, description?      Grid min?, gap?      Row gap?, align?, justify?
Stat label, value, hint?, tone?, info?      Text tone?, size?, mono?      Badge tone?, info?
Popover children, title?, rows?, content?, copy?      Markdown      Code lang?, title?
Table columns, rows, title?      Values values, title?      Callout tone?, title?      Spoiler title, open?
Checks > Check name, status: 'pass'|'fail'|'skip', detail?, group?, ms?, log?, video?, frame? | t?
Steps > Step name, status?, call?, detail?, ms?, video?, frame? | t?
Video src, id?, title?, label?, fps?, events?, log?, height?, frames?      silent scrubs frame by frame, sound plays normally; frames forces either
Videos > Video label?, offset?            angles on one timeline; sync={false} for separate runs
Log lines, title?, video?      Chart series: { name, points }[], unit?, video?, marks?, threshold?, title?
Compare before, after, beforeLabel?, afterLabel?, mode?: 'wipe'|'side'|'flip'|'diff'
BeforeAfter > Change name, before, after, result?, better?: 'lower'|'higher', unit?, video?, beforeT?, afterT?, beforeImage?, afterImage?
PlayerTable players, rows: { name, values, unit?, tolerance? }[]      multiplayer sync, host first
DiffTable columns, rows: { name, before?, after?, values? }[]      GitDiff commit? | from? + to?, paths?
Files files: { path, status?, diff? }[]      Image src, caption?      Carousel images
FrameLink video?, frame? | t?, report?      CodeRef path, line?, endLine?
Action label, run (a script with app globals; no unity, handles or video), tone?, confirm?
```
