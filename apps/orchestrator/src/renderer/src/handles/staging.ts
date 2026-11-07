import { defineHandle } from './registry'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function shownTuner(): Element {
  const root = [...document.querySelectorAll('[data-tuner-tab]')].find((r) => r.getBoundingClientRect().width > 0)
  if (!root) throw new Error('No Tuner is shown: open a scene Tuner on the staging scene first.')
  return root
}

function panelOf(root: Element): Element | null {
  return root.querySelector('[data-tuner-staging]')
}

function attr(el: Element, name: string): string {
  return el.getAttribute(name) ?? ''
}

function readReport(root: Element | null): unknown {
  const rep = root?.querySelector('[data-staging-report]')
  if (!rep) return null
  return {
    path: attr(rep, 'data-staging-report'),
    run: Number(attr(rep, 'data-staging-report-run')),
    metrics: [...rep.querySelectorAll('[data-staging-metric]')].map((m) => ({
      name: attr(m, 'data-staging-metric'),
      value: Number(attr(m, 'data-value')),
      ok: attr(m, 'data-ok') === 'yes',
      prev: attr(m, 'data-prev') ? Number(attr(m, 'data-prev')) : null,
      text: (m.textContent ?? '').replace(/\s+/g, ' ').trim()
    })),
    charts: [...rep.querySelectorAll('[data-staging-chart]')].map((c) => ({
      name: attr(c, 'data-staging-chart'),
      points: Number(attr(c, 'data-points')),
      iterations: Number(attr(c, 'data-iterations')),
      checks: Number(attr(c, 'data-checks')),
      width: Math.round(c.getBoundingClientRect().width)
    })),
    steps: [...rep.querySelectorAll('[data-staging-step]')].map((s) => ({ name: attr(s, 'data-staging-step'), t: Number(attr(s, 'data-t')) })),
    stepChecks: [...rep.querySelectorAll('[data-staging-step-check]')].map((s) => attr(s, 'data-staging-step-check')),
    failAt: rep.querySelector('[data-staging-fail-at]')?.getAttribute('data-staging-fail-at') ?? null,
    snapshots: [...rep.querySelectorAll('[data-staging-snapshot]')].map((b) => attr(b, 'data-staging-snapshot'))
  }
}

function readPanel(root: Element): unknown {
  const panel = panelOf(root)
  const toggle = root.querySelector('[data-tuner-staging-toggle]')
  if (!panel) return { open: false, toggle: !!toggle }
  const detail = panel.querySelector('[data-staging-detail]')
  const scroll = detail?.querySelector('[data-staging-scroll]')
  const full = document.querySelector('[data-staging-full]')
  const pathToggle = detail?.querySelector('[data-staging-path-toggle]')
  return {
    open: true,
    playing: panel.getAttribute('data-staging-playing') === 'yes',
    scene: attr(panel, 'data-staging-open-scene'),
    scenes: attr(panel, 'data-staging-scenes').split('\n').filter(Boolean),
    selected: detail?.getAttribute('data-staging-detail') ?? null,
    expanded: panel.getAttribute('data-staging-expanded') === 'yes',
    trails: root.querySelector('[data-staging-trails]')?.getAttribute('data-staging-trails') ?? null,
    detail: detail
      ? {
          text: (detail.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
          source: detail.querySelector('[data-staging-source]')?.getAttribute('data-staging-source') ?? null,
          video: detail.querySelector('[data-staging-video]')?.getAttribute('data-staging-video') ?? null,
          path: pathToggle ? attr(pathToggle, 'data-staging-path-toggle') : null,
          scroll: scroll ? { height: scroll.scrollHeight, client: scroll.clientHeight, top: Math.round(scroll.scrollTop), scrollable: scroll.scrollHeight > scroll.clientHeight + 1 } : null,
          report: readReport(detail)
        }
      : null,
    full: full ? { path: attr(full, 'data-staging-full'), report: readReport(full) } : null,
    items: [...panel.querySelectorAll('[data-staging-item]')].map((item) => ({
      group: item.getAttribute('data-staging-item'),
      scenarios: [...item.querySelectorAll('[data-staging-scenario]')].map((row) => ({
        path: row.getAttribute('data-staging-scenario'),
        status: row.getAttribute('data-staging-status'),
        result: row.getAttribute('data-staging-result') || null,
        loop: row.getAttribute('data-staging-loop') === 'yes',
        mark: (row.querySelector('[data-staging-mark]')?.textContent ?? '').trim(),
        tip: row.querySelector('[data-staging-mark]')?.getAttribute('data-ti-tip') ?? '',
        button: row.querySelector('[data-staging-stop]') ? 'stop' : row.querySelector('[data-staging-run]') ? 'run' : 'none',
        video: row.getAttribute('data-staging-video-file')
      }))
    }))
  }
}

async function openPanel(root: Element, open: boolean): Promise<void> {
  if (!!panelOf(root) === open) return
  const toggle = root.querySelector('[data-tuner-staging-toggle]') as HTMLButtonElement | null
  if (!toggle) throw new Error('This Tuner has no Staging button: open a scene Tuner.')
  toggle.click()
  for (let i = 0; i < 40 && !!panelOf(root) !== open; i++) await wait(50)
}

async function selectRow(root: Element, path: string): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const row = panelOf(root)?.querySelector(`[data-staging-scenario="${CSS.escape(path)}"]`) as HTMLElement | null
    if (row) {
      if (row.getAttribute('data-staging-selected') !== 'yes') row.click()
      for (let k = 0; k < 20 && !panelOf(root)?.querySelector(`[data-staging-detail="${CSS.escape(path)}"]`); k++) await wait(50)
      return true
    }
    await wait(50)
  }
  return false
}

async function rowButton(path: string, kind: 'run' | 'stop' | 'video'): Promise<HTMLElement> {
  const root = shownTuner()
  await openPanel(root, true)
  const sel = `[data-staging-${kind}="${CSS.escape(path)}"]`
  if (kind === 'video') await selectRow(root, path)
  for (let i = 0; i < 60; i++) {
    const detail = panelOf(root)?.querySelector(`[data-staging-detail="${CSS.escape(path)}"]`)
    const btn = kind === 'video' ? (detail?.querySelector('[data-staging-video]') as HTMLElement | null) : (panelOf(root)?.querySelector(sel) as HTMLElement | null)
    if (btn) return btn
    await wait(50)
  }
  const known = [...(panelOf(root)?.querySelectorAll('[data-staging-scenario]') ?? [])].map((r) => r.getAttribute('data-staging-scenario'))
  throw new Error(`No ${kind} button for ${path} in the Staging panel. Scenarios: ${known.join(', ') || 'none'}`)
}

defineHandle({
  name: 'staging.state',
  side: 'renderer',
  description:
    "Reads the Staging panel of the shown Tuner: whether it is open, Play or Edit Mode, the open scene and every staging scene of the project, each staging prefab with its scenarios (path, status idle/queued/running/done/error/stopped, result pass/fail, the ✓/✗/— mark and its tooltip, loop, which button shows, and the video path), the selected scenario and what its report shows (metric tiles with value, range and delta, charts with points, overlaid iterations and check markers, steps, snapshots, the script line of a failure, the video, scroll size, the path toggle), the full-screen report if open, and the tracked path drawn in the scene view (trails:points:last screen point). Returns { open, playing, scene, scenes, selected, expanded, trails, detail, full, items }.",
  params: {},
  run() {
    return readPanel(shownTuner())
  }
})

defineHandle({
  name: 'staging.open',
  side: 'renderer',
  description: 'Opens or closes the Staging panel of the shown Tuner by clicking its toolbar button, like a user. open: true or false. Returns the panel state.',
  params: { open: true },
  async run(p) {
    const root = shownTuner()
    await openPanel(root, p.open !== false)
    await wait(300)
    return readPanel(root)
  }
})

defineHandle({
  name: 'staging.run',
  side: 'renderer',
  description:
    'Clicks ▶ on a scenario in the Staging panel (opening the panel first). path is the scenario path, like DoorStaging/OpensWhenPlayerWalksIn. In Edit Mode the editor enters Play first. Returns the panel state right after the click; read staging.state again for the result.',
  params: { path: '' },
  async run(p) {
    const btn = await rowButton(String(p.path), 'run')
    btn.click()
    await wait(400)
    return readPanel(shownTuner())
  }
})

defineHandle({
  name: 'staging.stop',
  side: 'renderer',
  description: 'Clicks the stop button of a running scenario (a loop, or a run still going) in the Staging panel. path is the scenario path. Returns the panel state after the click.',
  params: { path: '' },
  async run(p) {
    const btn = await rowButton(String(p.path), 'stop')
    btn.click()
    await wait(400)
    return readPanel(shownTuner())
  }
})

defineHandle({
  name: 'staging.select',
  side: 'renderer',
  description: 'Clicks a scenario row in the Staging panel, which shows its report on the right: result, time, loop counts, the failed check with its script line, metrics, charts, steps, snapshots and the video of an agent run. path is the scenario path. Returns the panel state.',
  params: { path: '' },
  async run(p) {
    const root = shownTuner()
    await openPanel(root, true)
    if (!(await selectRow(root, String(p.path)))) throw new Error(`No scenario ${p.path} in the Staging panel.`)
    await wait(100)
    return readPanel(root)
  }
})

defineHandle({
  name: 'staging.video',
  side: 'renderer',
  description: "Clicks the video link of a scenario's last run in the Staging panel, which opens the video in the app. path is the scenario path. Returns the video file path.",
  params: { path: '' },
  async run(p) {
    const btn = await rowButton(String(p.path), 'video')
    const file = btn.getAttribute('data-staging-video')
    btn.click()
    return { video: file }
  }
})

async function waitFor<T>(get: () => T | null | undefined, tries = 40): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    const v = get()
    if (v) return v
    await wait(50)
  }
  return null
}

defineHandle({
  name: 'staging.scene',
  side: 'renderer',
  description:
    "Opens another staging scene from the Staging panel header: clicks the scene name, then the scene in the list. path is the scene asset path, like Assets/Staging/DoorsScene.unity. Unsaved changes ask first, as for any scene switch. Returns the panel state right after the click; read staging.state again once the scene has loaded.",
  params: { path: '' },
  async run(p) {
    const root = shownTuner()
    await openPanel(root, true)
    const want = String(p.path)
    const sw = (await waitFor(() => panelOf(root)?.querySelector('[data-staging-scene-switch]') as HTMLElement | null)) as HTMLElement | null
    if (!sw) throw new Error('The Staging panel shows no scene switch: this project has no other staging scene.')
    if (!document.querySelector('[data-staging-scene-menu]')) sw.click()
    const item = (await waitFor(() => document.querySelector(`[data-staging-scene="${CSS.escape(want)}"]`) as HTMLElement | null)) as HTMLElement | null
    if (!item) {
      const known = [...document.querySelectorAll('[data-staging-scene]')].map((e) => e.getAttribute('data-staging-scene'))
      throw new Error(`No staging scene ${want}. Staging scenes: ${known.join(', ') || 'none'}`)
    }
    item.click()
    await wait(300)
    return readPanel(root)
  }
})

defineHandle({
  name: 'staging.expand',
  side: 'renderer',
  description: "Shows the selected scenario's report full screen (open: true) by clicking its expand button, or closes the full-screen report (open: false) with its close button. Returns the panel state.",
  params: { open: true },
  async run(p) {
    const root = shownTuner()
    const open = p.open !== false
    if (open) {
      const btn = panelOf(root)?.querySelector('[data-staging-expand]') as HTMLElement | null
      if (!btn) throw new Error('No expand button: select a scenario that has a report.')
      btn.click()
      await waitFor(() => document.querySelector('[data-staging-full]'))
    } else {
      const close = document.querySelector('[data-report-overlay="staging"] [data-fs-close]') as HTMLElement | null
      close?.click()
      await waitFor(() => (document.querySelector('[data-staging-full]') ? null : true))
    }
    await wait(150)
    return readPanel(root)
  }
})

defineHandle({
  name: 'staging.path',
  side: 'renderer',
  description: "Shows or hides the tracked path of the selected scenario in the scene view by clicking the Path toggle of its report. show: true or false. Returns the panel state.",
  params: { show: true },
  async run(p) {
    const root = shownTuner()
    const btn = panelOf(root)?.querySelector('[data-staging-path-toggle]') as HTMLElement | null
    if (!btn) throw new Error('No Path toggle: the selected scenario tracks no object (Track).')
    if ((btn.getAttribute('data-staging-path-toggle') === 'on') !== (p.show !== false)) btn.click()
    await wait(200)
    return readPanel(root)
  }
})

defineHandle({
  name: 'staging.snapshot',
  side: 'renderer',
  description: "Clicks a snapshot in the filmstrip of the selected scenario's report, which opens the image in the app. index counts from 0, in the order shown. Returns the image path.",
  params: { index: 0 },
  async run(p) {
    const root = shownTuner()
    const list = [...(panelOf(root)?.querySelectorAll('[data-staging-snapshot]') ?? [])] as HTMLElement[]
    const btn = list[Number(p.index) || 0]
    if (!btn) throw new Error(`No snapshot ${p.index}: the report shows ${list.length}.`)
    btn.click()
    return { snapshot: btn.getAttribute('data-staging-snapshot') }
  }
})
