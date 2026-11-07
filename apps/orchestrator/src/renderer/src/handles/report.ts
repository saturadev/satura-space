import { defineHandle } from './registry'
import { useAppStore } from '../store'
import { requestViewerFind } from '../lib/shortcuts/pane-actions'
import { frameChannelOf, type FrameChannel } from '../components/report/frame-host'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function reportTab(suffix: string): string {
  const tabs = Object.entries(useAppStore.getState().viewerFileByTab).filter(([, f]) => /(^|\/)report\.tsx$|\.report\.tsx$/i.test(f) && f.endsWith(suffix))
  if (!tabs.length) throw new Error(`No report tab shows a file ending with ${suffix || 'report.tsx'}.`)
  return tabs[0][0]
}

function frameOf(tab: string): FrameChannel {
  const el = document.querySelector(`[data-tab-id="${CSS.escape(tab)}"] [data-viewer-report] iframe[data-report-frame]`) ?? document.querySelector('[data-viewer-report] iframe[data-report-frame]')
  const channel = frameChannelOf(el)
  if (!channel?.isReady()) throw new Error('The report is not on screen.')
  return channel
}

defineHandle({
  name: 'report.view',
  side: 'renderer',
  description:
    "Reads the report shown in the viewer tab whose file ends with file (the first report tab when empty): the block count of its virtual list, which blocks are mounted and which are visible, the first visible block with its top and text, scrollTop, scrollHeight, clientHeight and DOM node count. scrollTop >= 0 scrolls there first. anchor: 'id' clicks a link to #id the way a report link does, even when the target block is not mounted, and returns where the target landed. click: 'selector' clicks the first element inside the report that matches, like a frame link, and waits for the report to settle. find: 'text' opens the viewer's find bar and types it, then returns the match count, the active match and where the report scrolled; close: true closes the find bar afterwards. Returns that state.",
  params: { file: '', scrollTop: -1, anchor: '', click: '', find: '', close: false },
  async run(p) {
    const tab = reportTab(String(p.file ?? ''))
    const frame = frameOf(tab)
    const top = Number(p.scrollTop)
    const anchor = String(p.anchor ?? '')
    const click = String(p.click ?? '')
    const first = await frame.query<Record<string, unknown>>({ q: 'view', scrollTop: Number.isFinite(top) && top >= 0 ? top : undefined, anchor: anchor || undefined, click: click || undefined }, 20000)
    const out: Record<string, unknown> = {}
    if (anchor) out.anchor = first.anchor ?? null
    const text = String(p.find ?? '')
    if (text) {
      if (!requestViewerFind(tab)) throw new Error('This tab has no find bar.')
      await wait(300)
      const bar = document.querySelector<HTMLElement>('[data-find-bar]')
      const input = bar?.querySelector<HTMLInputElement>('input')
      if (!bar || !input) throw new Error('The find bar did not open.')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      let last = ''
      for (let i = 0; i < 30; i++) {
        await wait(150)
        const now = `${bar.dataset.findCount}/${bar.dataset.findActive}`
        if (now === last && bar.dataset.findCount !== undefined) break
        last = now
      }
      await wait(300)
      const seen = await frameOf(tab).query<Record<string, unknown>>({ q: 'view' }, 20000)
      out.find = { count: Number(bar.dataset.findCount), active: Number(bar.dataset.findActive), scrollTop: seen.scrollTop, mountedWhileOpen: Array.isArray(seen.mounted) ? seen.mounted.length : 0 }
      if (p.close) {
        bar.querySelector<HTMLButtonElement>('button[aria-label="Close find"]')?.click()
        await wait(500)
      }
    }
    const { anchor: _a, ...state } = await frameOf(tab).query<Record<string, unknown>>({ q: 'view' }, 20000)
    return { ...state, ...out }
  }
})

defineHandle({
  name: 'report.frame',
  side: 'renderer',
  description:
    'Checks the sandbox of the report shown in the viewer tab whose file ends with file (the first report tab when empty): the report runs in an iframe with an opaque origin and no preload. Returns typeof window.api inside the frame, what touching window.parent.document gives, the frame origin, the iframe sandbox attribute, the frame URL and box as the app page sees it. count: [selectors] counts matches inside the report, rect: a selector whose first match gives its box in frame coordinates, text: a selector whose first match gives its text.',
  params: { file: '', count: [] as string[], rect: '', text: '' },
  async run(p) {
    const tab = reportTab(String(p.file ?? ''))
    const frame = frameOf(tab)
    const count = Array.isArray(p.count) ? p.count.map(String) : []
    const inside = await frame.query<Record<string, unknown>>({ q: 'probe', count, rect: String(p.rect ?? '') || undefined, text: String(p.text ?? '') || undefined }, 10000)
    const box = frame.iframe?.getBoundingClientRect()
    return {
      ...inside,
      sandbox: frame.iframe?.getAttribute('sandbox') ?? null,
      src: frame.iframe?.getAttribute('src') ?? (frame.iframe?.hasAttribute('srcdoc') ? 'srcdoc' : null),
      frameBox: box ? { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) } : null
    }
  }
})

defineHandle({
  name: 'report.video',
  side: 'renderer',
  description:
    "Drives a video player in the report shown in the viewer tab whose file ends with file (the first report tab when empty). index picks the player in page order, or name a part of its file name. steps run in order: {do:'state'}, {do:'goto', frame|t}, {do:'step', by: ±n} (clicks the frame step button n times), {do:'scrub', from, to, steps, ms} (drags the timeline with the mouse), {do:'play', ms}, {do:'pause'}, {do:'wait', ms}, {do:'unmute'}. Each result has the player state after the step (decode path, codec, fps, frame asked for, frame shown, buffered seconds, status; for a sound player currentTime, paused, muted, audio bytes decoded) and the frame decodes it caused with their times.",
  params: { file: '', index: 0, name: '', steps: [] as unknown[] },
  async run(p) {
    const tab = reportTab(String(p.file ?? ''))
    const steps = Array.isArray(p.steps) && p.steps.length ? p.steps : [{ do: 'state' }]
    return frameOf(tab).query<Record<string, unknown>>({ q: 'video', index: Number(p.index) || 0, name: String(p.name ?? '') || undefined, steps: steps as never }, 120000)
  }
})

defineHandle({
  name: 'report.select',
  side: 'renderer',
  description:
    "Selects the text of the first element matching selector inside the report shown in the viewer tab whose file ends with file (the first report tab when empty), the way a drag over it does, and focuses the report. Returns whether it matched, the selected text and the element's computed user-select. report.copy uses it to check copying.",
  params: { file: '', selector: '' },
  async run(p) {
    const tab = reportTab(String(p.file ?? ''))
    return frameOf(tab).query<Record<string, unknown>>({ q: 'select', selector: String(p.selector ?? '') }, 10000)
  }
})
