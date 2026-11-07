import { app, clipboard, webContents } from 'electron'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileReport } from '../report/compile'
import { openReport } from '../satura-exec'
import { defineHandle, sleep, waitUntil, TEST_PROJECT } from './registry'
import fullReport from './fixtures/report.tsx.txt?raw'

const MINIMAL = `import { Report, Summary, Checks, Check, Text } from '@satura/report'

export default function SeededReport() {
  return (
    <Report title="TITLE">
      <Summary tone="ok">A short report seeded by the report.seed handle.</Summary>
      <Checks title="Checks">
        <Check name="Compiles" status="pass" detail="The report compiled" />
        <Check name="Measured" status="skip" detail="Nothing was measured" />
      </Checks>
      <Text>Edit this file to try report features.</Text>
    </Report>
  )
}
`

const MEDIA = [
  ['game-stream.mp4', 'run.mp4'],
  ['satura-race.jpg', 'before.jpg'],
  ['satura-ghosts.jpg', 'after.jpg'],
  ['game-stream.jpg', 'stream.jpg']
]

defineHandle({
  name: 'report.seed',
  side: 'main',
  description:
    `Writes a report into .sspace/reports/<name>/report.tsx of the test project. preset 'full' has a summary, stats, checks, a video with events and a log, a table, a before/after compare, a three-image Carousel and an Image, using sample media from the landing folder (needs git lfs pull); 'minimal' is a few checks and no media. Compiles it, and opens it in the report viewer when open is true. Only runs on ${TEST_PROJECT}. Returns the file, whether it compiled, the compile errors, the viewer tab (close it with layout.close) and any missing media.`,
  params: { preset: 'full', name: 'handles-report', title: 'Seeded report', open: true },
  async run(p, ctx) {
    const project = ctx.writableProject()
    const name = String(p.name ?? '').replace(/[^A-Za-z0-9._-]+/g, '-') || 'handles-report'
    const dir = join(project, '.sspace', 'reports', name)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const full = p.preset !== 'minimal'
    const missing: string[] = []
    if (full) {
      const media = join(app.getAppPath(), '..', 'landing', 'product', 'media')
      for (const [from, to] of MEDIA) {
        const src = join(media, from)
        if (existsSync(src)) copyFileSync(src, join(dir, to))
        else missing.push(src)
      }
    }
    const file = join(dir, 'report.tsx')
    writeFileSync(file, (full ? fullReport : MINIMAL).replace('TITLE', String(p.title ?? 'Seeded report')))
    const res = await compileReport(file, project)
    const compiled = { ok: res.ok, ms: res.ms, errors: res.ok ? [] : res.text.split('\n').slice(0, 20) }
    let opened: string | null = null
    let tab: unknown = null
    if (p.open && res.ok) {
      if (ctx.window === null) throw new Error('No window to open the report in.')
      opened = (await openReport({ path: file }, { window: ctx.window, projectRoot: project, paneKey: ctx.paneKey })).file
      const want = opened.replace(/\\/g, '/')
      tab = await waitUntil('the report tab', async () => {
        const state = (await ctx.renderer('app.state')) as { tabs?: { file?: string }[] } | null
        return state?.tabs?.find((t) => t.file?.replace(/\\/g, '/') === want) ?? null
      }, 10_000, ctx.signal).catch(() => null)
    }
    return { file, compiled, opened, tab, missing }
  }
})

defineHandle({
  name: 'report.copy',
  side: 'main',
  description:
    "Copies text out of the report shown in the viewer tab whose file ends with file (the first report tab when empty) the way Cmd+C does: report.select selects the text of the first element inside the report that matches selector, then the window runs Copy, reads the clipboard and puts back the text it held before. Returns whether it matched, the selection, the element's computed user-select and the text the clipboard got.",
  params: { file: '', selector: '' },
  async run(p, ctx) {
    if (ctx.window === null) throw new Error('No window to copy from.')
    const wc = webContents.fromId(ctx.window)
    if (!wc) throw new Error('The window is gone.')
    const picked = (await ctx.renderer('report.select', { file: String(p.file ?? ''), selector: String(p.selector ?? '') })) as Record<string, unknown>
    const before = await clipboard.readText()
    clipboard.writeText('')
    wc.copy()
    await sleep(300)
    const copied = await clipboard.readText()
    clipboard.writeText(before)
    ctx.log(`[report] Copy in the report put ${copied.length} characters on the clipboard`)
    return { ...picked, copied }
  }
})
