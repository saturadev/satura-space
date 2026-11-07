import { useEffect, useState } from 'react'
import type { RemoteHello } from '@shared/remote-protocol'
import { useAppStore } from '../store'
import { getTerminalInstance } from '../lib/terminal/terminal-registry'
import { hookStatus } from '../lib/agent-status'
import { pathBasename, workspaceTitle } from '../lib/path'
import { reloadWorlds, useWorldStore } from '../lib/unity/world-store'
import { reloadUnityLifecycles } from '../lib/unity/lifecycle-store'
import { primaryWorldId } from '@shared/unity/ids'
import { cleanHostKind, hostKindLabel } from '@shared/remote-host-kind'
import { getMac, updateMac } from './macs'
import { checkNetworkAgain, connectionState, currentHostId, invokeRemote, liveOutage, liveProbe, liveSynced, liveSyncFailed, onDrive, setHostLogs, socketAlive, stopConnecting, tryAgain, wsTransport } from './ws-transport'
import { applyMirrorSession } from './mirror'
import { applyRestorePrompts } from './restore-prompts'
import { exposeToShell, postToShell } from './shell-bus'
import { PhonePanels, resendPresence, shownTerminalPty } from './phone-panels'
import { WebShell } from './web-shell/WebShell'
import { FileVersionsSheet } from './FileVersionsSheet'

let helloRun: Promise<unknown> = Promise.resolve()

function unityStates(): Record<string, { state: string; version: number }> {
  const out: Record<string, { state: string; version: number }> = {}
  for (const [pp, w] of Object.entries(useWorldStore.getState().worlds)) {
    const inst = w.observed.instances[primaryWorldId(pp)]
    const state = inst ? `${inst.lifecycle}${inst.paused ? ' paused' : ''}${inst.compile === 'idle' ? '' : ` ${inst.compile}`}` : 'no editor'
    out[pp] = { state, version: w.observed.version }
  }
  return out
}

function pullWorlds(): Promise<void> {
  const before = unityStates()
  return reloadWorlds().then(() => {
    const after = unityStates()
    const names = Object.keys(after)
    if (!names.length) return
    const notes = names.flatMap((pp) => {
      const was = before[pp]
      const now = after[pp]
      if (!was) return []
      const moved = was.state !== now.state ? ` ${now.state} (was ${was.state})` : ''
      const over = now.version < was.version ? ' after the desktop started over' : ''
      return moved || over ? [`${pathBasename(pp)}${moved}${over}`] : []
    })
    console.info(`[unity] phone took the Unity state of ${names.length} project(s) from the Mac${notes.length ? `: ${notes.join(', ')}` : ', nothing had changed'}`)
  })
}

function pullLifecycles(): Promise<void> {
  return reloadUnityLifecycles('the phone connected again and asked the desktop').then((lines) => {
    if (lines.length) console.info(`[unity] phone took the Unity state machine of ${lines.length} project(s) from the Mac: ${lines.join(', ')}`)
  })
}

function keepKind(hello: RemoteHello): void {
  const host = currentHostId()
  const kind = cleanHostKind(hello.kind)
  if (!host || JSON.stringify(getMac(host)?.kind ?? null) === JSON.stringify(kind)) return
  updateMac(host, { kind })
  console.info(`[macs] ${host} is a ${kind?.os} ${kind?.form}, shown as ${hostKindLabel(kind) || 'a plain desktop'}`)
}

function pullHello(): Promise<RemoteHello> {
  const worlds = Promise.all([pullWorlds(), pullLifecycles()])
  const hello = invokeRemote<RemoteHello>('remote:hello').then((hello) => {
    setHostLogs(hello.phoneLogs)
    applyMirrorSession(hello.session)
    applyRestorePrompts(hello.restorePrompts ?? [])
    keepKind(hello)
    postToShell({ type: 'host', hostName: hello.hostName, version: hello.version })
    return hello
  })
  return Promise.all([hello, worlds]).then(([h]) => h)
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

async function resync(): Promise<void> {
  const outage = liveOutage()
  if (outage || !socketAlive()) {
    console.info(`[remote] resync: ${connectionState().state}${outage ? ` (${outage})` : ''}, not connected, nothing to refresh`)
    return
  }
  if (!(await liveProbe())) throw new Error("the desktop didn't answer the check")
  try {
    await within(pullHello(), 4000, 'The desktop')
    console.info('[remote] resync: the socket was alive, state refreshed')
  } catch (e) {
    liveSyncFailed((e as Error).message)
  }
}

function terminalState(): Record<string, unknown> {
  const pty = shownTerminalPty()
  const term = pty ? getTerminalInstance(pty) : undefined
  if (!term) return { pty }
  const buf = term.buffer.active
  const lines: string[] = []
  for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) {
    const text = buf.getLine(y)?.translateToString(true)
    if (text?.trim()) lines.push(text)
  }
  lines.splice(0, Math.max(0, lines.length - 14))
  const box = term.element?.parentElement?.getBoundingClientRect()
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect()
  const rowHeight = screen && term.rows > 0 ? screen.height / term.rows : 0
  const hits: { text: string; x: number; y: number }[] = []
  for (let i = 0; screen && i < term.rows; i++) {
    const text = buf.getLine(buf.viewportY + i)?.translateToString(true) ?? ''
    if (text.trim()) hits.push({ text: text.trim().slice(0, 60), x: Math.round(screen.left + screen.width / 3), y: Math.round(screen.top + (i + 0.5) * rowHeight) })
  }
  return { pty, cols: term.cols, rows: term.rows, host: box ? [Math.round(box.width), Math.round(box.height)] : null, tail: lines, rowHits: hits }
}

function panelState(): Record<string, unknown> | null {
  const el = document.querySelector<HTMLElement>('[data-phone-panel]')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return {
    kind: el.dataset.phonePanel,
    tab: el.dataset.tabId,
    rect: [Math.round(r.top), Math.round(r.bottom), Math.round(r.width)],
    text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300)
  }
}

function hitProbe(): Record<string, unknown> | null {
  const root = document.querySelector<HTMLElement>('[data-phone-panel]')
  if (!root) return null
  const els = [...root.querySelectorAll<HTMLElement>('button, [role="button"], .scm-row, input, select, [data-ctx-menu]')]
  let ok = 0
  let missed = 0
  const misses: string[] = []
  for (const el of els) {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) continue
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    let clipped = false
    for (let a = el.parentElement; a && !clipped; a = a === root ? null : a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
      const c = a.getBoundingClientRect()
      clipped = x < c.left || x > c.right || y < c.top || y > c.bottom
    }
    if (clipped) continue
    const hit = document.elementFromPoint(x, y)
    if (hit && (el === hit || el.contains(hit) || hit.contains(el))) ok++
    else if (++missed <= 8) misses.push(`${(el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 24)}@${Math.round(x)},${Math.round(y)} ${Math.round(r.width)}x${Math.round(r.height)}->${hit ? (hit.getAttribute('aria-label') || hit.textContent || hit.tagName).trim().slice(0, 24) : 'none'}`)
  }
  const zoomed = root.firstElementChild instanceof HTMLElement ? getComputedStyle(root.firstElementChild).zoom : ''
  return { kind: root.dataset.phonePanel, zoom: zoomed, checked: ok + missed, ok, missed, misses }
}

interface DriveTouch {
  x: number
  y: number
  x2?: number
  y2?: number
  hold?: number
  steps?: number
}

async function driveTouch(m: DriveTouch): Promise<void> {
  const target = document.elementFromPoint(m.x, m.y)
  if (!target) {
    console.info(`[drive] touch ${m.x},${m.y}: nothing there`)
    return
  }
  const at = (x: number, y: number): Touch => new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y })
  const fire = (type: string, x: number, y: number, ended = false): void => {
    const t = at(x, y)
    target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: ended ? [] : [t], targetTouches: ended ? [] : [t], changedTouches: [t] }))
  }
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  fire('touchstart', m.x, m.y)
  if (m.hold) await wait(m.hold)
  const x2 = m.x2 ?? m.x
  const y2 = m.y2 ?? m.y
  const steps = x2 !== m.x || y2 !== m.y ? m.steps ?? 8 : 0
  for (let i = 1; i <= steps; i++) {
    fire('touchmove', m.x + ((x2 - m.x) * i) / steps, m.y + ((y2 - m.y) * i) / steps)
    await wait(16)
  }
  fire('touchend', x2, y2, true)
  console.info(`[drive] touch ${m.x},${m.y}${steps ? ` -> ${x2},${y2}` : ''}${m.hold ? ` held ${m.hold}ms` : ''} on ${target.tagName.toLowerCase()}`)
}

function driveState(): Record<string, unknown> {
  const s = useAppStore.getState()
  return {
    connection: connectionState(),
    workspaces: s.workspaces.map((w) => ({ id: w.id, title: workspaceTitle(w) })),
    activeWorkspaceId: s.activeWorkspaceId,
    terminal: terminalState(),
    panel: panelState(),
    hits: hitProbe(),
    viewport: { w: window.innerWidth, h: window.innerHeight, vv: window.visualViewport?.height ?? null, dpr: window.devicePixelRatio },
    focus: document.activeElement?.className || document.activeElement?.tagName || null
  }
}

export function RemoteApp() {
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    const onOnline = (): void => {
      helloRun = pullHello().then((hello) => {
        resendPresence()
        console.info(`[remote] hello from ${hello.hostName} ${hello.version}: ${useAppStore.getState().workspaces.length} workspaces`)
        return useAppStore
          .getState()
          .loadSettings()
          .catch(() => {})
          .then(() => setEpoch((e) => e + 1))
      })
      helloRun.then(
        () => liveSynced(),
        (e: Error) => liveSyncFailed(e?.message ?? String(e))
      )
    }
    const off = wsTransport.on('remote:online', onOnline)
    if (connectionState().state === 'online') onOnline()
    return off
  }, [])

  useEffect(
    () =>
      window.api.pty.onAgentHook((event) => {
        useAppStore.getState().setAgentHookStatus(event.id, hookStatus(event.kind))
      }),
    []
  )

  useEffect(() => {
    const load = (): void => {
      void window.api.pty
        .agentStates()
        .then((events) => {
          const s = useAppStore.getState()
          for (const e of events ?? []) s.setAgentHookStatus(e.id, hookStatus(e.kind))
        })
        .catch(() => {})
    }
    const off = wsTransport.on('remote:online', load)
    if (connectionState().state === 'online') load()
    return off
  }, [])

  useEffect(() => {
    exposeToShell({ resync: () => resync(), probe: () => liveProbe(), stopConnecting: (why: string) => stopConnecting(String(why)), connectAgain: (why: string) => tryAgain(String(why)), checkNetwork: (why: string) => checkNetworkAgain(String(why)) })
    return onDrive((m) => {
      if (m.action === 'reload') return location.reload()
      if (m.action === 'tap') {
        const want = String(m.text ?? '')
        const el = want
          ? [...document.querySelectorAll<HTMLElement>('[data-phone-panel] *')].find((e) => e.children.length === 0 && e.textContent?.trim() === want)?.closest<HTMLElement>('.scm-row, button, [role="button"], a') ?? null
          : document.querySelector<HTMLElement>(String(m.selector ?? ''))
        console.info(`[drive] tap ${want || m.selector}: ${el ? 'clicked' : 'not found'}`)
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el?.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }))
        el?.click()
        return
      }
      if (m.action === 'touch') {
        void driveTouch(m as unknown as DriveTouch)
        return
      }
      if (m.action === 'state') console.info(`[drive] web state ${JSON.stringify(driveState())}`)
    })
  }, [])

  return (
    <>
      <PhonePanels epoch={epoch} />
      <WebShell />
      <FileVersionsSheet />
    </>
  )
}
