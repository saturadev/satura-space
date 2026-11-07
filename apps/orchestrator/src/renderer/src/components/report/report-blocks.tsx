import { Children, Fragment, isValidElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react'
import { Virtualizer, type CustomItemComponentProps, type VirtualizerHandle } from 'virtua'
import { FIND_OPEN_EVENT, findIsOpen, type FindOpenDetail } from '../../lib/find-in-view'
import { useReport, type BlockTest, type ReportApi } from './report-context'
import type { BlockPlace } from './report-view-state'

const KEPT_TOUCHED = 12
const RESTORE_MS = 700
const REVEAL_MS = 4000
const PIN_MS = 2500
const BUFFER_SCREENS = 1.5
const MIN_BUFFER = 600

export function blockList(children: ReactNode, prefix = ''): ReactElement[] {
  const out: ReactElement[] = []
  for (const child of Children.toArray(children)) {
    const key = `${prefix}${isValidElement(child) ? String(child.key) : `.${out.length}`}`
    if (isValidElement(child) && child.type === Fragment) out.push(...blockList((child.props as { children?: ReactNode }).children, `${key}/`))
    else out.push(<Fragment key={key}>{child}</Fragment>)
  }
  return out
}

function findBlock(node: ReactNode, test: BlockTest, depth = 0): ReactElement | null {
  if (depth > 24 || node == null || typeof node === 'boolean') return null
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findBlock(n, test, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (!isValidElement(node)) return null
  if (test(node)) return node
  return findBlock((node.props as { children?: ReactNode }).children, test, depth + 1)
}

const slug = (text: string): string =>
  text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-')

export function anchorTest(id: string): BlockTest {
  return (el) => {
    const p = el.props as { id?: unknown; children?: unknown }
    if (p.id === id) return true
    if (typeof p.children !== 'string' || !p.children.includes('#')) return false
    const seen = new Map<string, number>()
    for (const m of p.children.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
      const base = slug(m[1])
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      if ((n ? `${base}-${n}` : base) === id) return true
    }
    return false
  }
}

function Item({ style, index, children, ref }: CustomItemComponentProps): ReactElement {
  return (
    <div ref={ref as RefObject<HTMLDivElement>} style={style} className="rk-vitem" data-rk-item={index}>
      <div className="rk-vbody">{children}</div>
    </div>
  )
}

const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

function unitOf(el: HTMLElement): number {
  const z = (el as { currentCSSZoom?: number }).currentCSSZoom
  if (typeof z === 'number' && z > 0) return z
  return el.offsetHeight > 0 ? el.getBoundingClientRect().height / el.offsetHeight || 1 : 1
}

function VirtualBlocks({ api, blocks, scroller }: { api: ReportApi; blocks: ReactElement[]; scroller: RefObject<HTMLElement | null> }): ReactElement {
  const view = api.host.view
  const handle = useRef<VirtualizerHandle>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const margin = useRef(0)
  const [startMargin, setStartMargin] = useState(-1)
  const [buffer, setBuffer] = useState(MIN_BUFFER)
  const [touched, setTouched] = useState<number[]>([])
  const [pinned, setPinned] = useState<number[]>([])
  const [near, setNear] = useState<[number, number] | null>(null)
  const [all, setAll] = useState(() => (scroller.current && findIsOpen(scroller.current) ? 1 : 0))
  const [checked, setChecked] = useState(false)
  const count = blocks.length
  const [saved] = useState<BlockPlace | null>(() => {
    const b = view?.blocks
    return b && b.index < count ? b : null
  })
  const [cache] = useState(() => (saved && saved.count === count ? (saved.cache ?? undefined) : undefined))
  const [restoring, setRestoring] = useState(() => !!saved && (saved.index > 0 || Math.abs(saved.within) > 1))
  const committed = useRef<(() => void)[]>([])
  const [, setTick] = useState(0)
  const checking = useRef(0)
  const remeasured = useRef(new Set<number>())
  const live = useRef({ blocks, count, buffer })
  live.current = { blocks, count, buffer }
  const hostOf = (): HTMLElement | null => scroller.current ?? listRef.current?.closest<HTMLElement>('.rk-host') ?? null
  const marginOf = (host: HTMLElement): number => {
    const list = listRef.current
    if (!list) return margin.current
    return Math.max(0, Math.round((list.getBoundingClientRect().top - host.getBoundingClientRect().top) / unitOf(list) + host.scrollTop))
  }

  const keep = useMemo(() => {
    if (all > 0) return blocks.map((_, i) => i)
    const set = new Set([...touched, ...pinned])
    if (near) for (let i = near[0]; i <= near[1]; i++) set.add(i)
    return set.size ? [...set].filter((i) => i < count).sort((a, b) => a - b) : undefined
  }, [all, touched, pinned, near, count, blocks])

  useLayoutEffect(() => {
    const done = committed.current.splice(0)
    if (done.length) requestAnimationFrame(() => requestAnimationFrame(() => done.forEach((f) => f())))
  })

  useLayoutEffect(() => {
    const host = hostOf()
    const list = listRef.current
    if (!host || !list) return
    const measure = (): void => {
      if (!host.clientHeight || !list.getClientRects().length) return
      const m = marginOf(host)
      margin.current = m
      setStartMargin((prev) => (Math.abs(prev - m) >= 1 ? m : prev))
      const b = Math.max(MIN_BUFFER, Math.round(host.clientHeight * BUFFER_SCREENS))
      setBuffer((prev) => (Math.abs(prev - b) > 40 ? b : prev))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return () => ro.disconnect()
  }, [scroller])

  useLayoutEffect(() => {
    const host = hostOf()
    if (!saved || !host || !restoring) return
    const started = performance.now()
    let stop = false
    let steady = 0
    let raf = 0
    const quit = (): void => {
      stop = true
      setRestoring(false)
    }
    const apply = (): void => {
      if (stop) return
      const h = handle.current
      if (h) {
        const target = marginOf(host) + h.getItemOffset(saved.index) + saved.within
        if (Math.abs(host.scrollTop - target) > 1) {
          host.scrollTop = target
          steady = 0
        } else steady++
      }
      if (steady >= 3 || performance.now() - started > RESTORE_MS) return quit()
      raf = requestAnimationFrame(apply)
    }
    raf = requestAnimationFrame(apply)
    const types = ['wheel', 'touchstart', 'pointerdown', 'keydown']
    for (const t of types) host.addEventListener(t, quit, { passive: true })
    return () => {
      stop = true
      cancelAnimationFrame(raf)
      for (const t of types) host.removeEventListener(t, quit)
    }
  }, [])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const note = (e: Event): void => {
      if (e.type === 'pointerdown' && (e as PointerEvent).pointerType !== 'mouse') return
      const item = (e.target instanceof Element ? e.target : null)?.closest('[data-rk-item]')
      if (!item || !list.contains(item)) return
      const i = Number(item.getAttribute('data-rk-item'))
      setTouched((prev) => (prev[prev.length - 1] === i ? prev : [...prev.filter((x) => x !== i), i].slice(-KEPT_TOUCHED)))
    }
    const types = ['pointerdown', 'click', 'focusin', 'play', 'seeking', 'toggle', 'input', 'change']
    for (const t of types) list.addEventListener(t, note, true)
    return () => {
      for (const t of types) list.removeEventListener(t, note, true)
    }
  }, [])

  useEffect(() => {
    const host = scroller.current
    if (!host) return
    const on = (e: Event): void => {
      const d = (e as CustomEvent<FindOpenDetail>).detail
      if (!d) return
      if (!d.open) {
        setAll((n) => Math.max(0, n - 1))
        return
      }
      d.ready = new Promise<void>((resolve) => committed.current.push(resolve))
      setAll((n) => n + 1)
    }
    host.addEventListener(FIND_OPEN_EVENT, on)
    return () => host.removeEventListener(FIND_OPEN_EVENT, on)
  }, [scroller])

  useEffect(() => {
    const indexOf = (el: HTMLElement): number => {
      const item = el.closest('[data-rk-item]')
      return item && listRef.current?.contains(item) ? Number(item.getAttribute('data-rk-item')) : -1
    }
    const rendered = (): Promise<void> =>
      new Promise((resolve) => {
        committed.current.push(resolve)
        setTick((n) => n + 1)
      })
    const until = async (find: () => HTMLElement | null): Promise<HTMLElement | null> => {
      const started = performance.now()
      for (;;) {
        const el = find()
        if (el || performance.now() - started > REVEAL_MS) return el
        await frame()
      }
    }
    const pin = (list: number[]): void => {
      setPinned((prev) => [...new Set([...prev, ...list])])
      window.setTimeout(() => setPinned((prev) => prev.filter((x) => !list.includes(x))), PIN_MS)
    }
    const around = (i: number): number[] => {
      const h = handle.current
      const host = hostOf()
      const out = [i]
      if (!h || !host) return out
      const view = host.clientHeight
      for (let k = i - 1, sum = 0; k >= 0 && sum < view; k--) {
        out.push(k)
        sum += h.getItemSize(k)
      }
      for (let k = i + 1, sum = h.getItemSize(i); k < live.current.count && sum < view * 1.5; k++) {
        out.push(k)
        sum += h.getItemSize(k)
      }
      return out
    }
    const off = api.attachBlocks({
      first: (test) => {
        for (const b of live.current.blocks) {
          const hit = findBlock(b, test)
          if (hit) return hit
        }
        return null
      },
      reveal: async (test, find) => {
        const now = find()
        if (now) return now
        const index = test ? live.current.blocks.findIndex((b) => !!findBlock(b, test)) : -1
        if (index >= 0) {
          const wait = rendered()
          pin(around(index))
          await wait
          const el = await until(find)
          console.info(`[report] block ${index} of ${live.current.count} ${el ? 'mounted to reveal its target' : 'mounted, but the target did not show up'}`)
          return el
        }
        const wait = rendered()
        setAll((n) => n + 1)
        await wait
        const el = await until(find)
        const at = el ? indexOf(el) : -1
        if (at >= 0) pin(around(at))
        setAll((n) => Math.max(0, n - 1))
        console.info(`[report] mounted all ${live.current.count} blocks to look for a target: ${at >= 0 ? `found in block ${at}` : 'not found'}`)
        return el
      },
      jump: (el, align) => {
        const h = handle.current
        const host = hostOf()
        const index = indexOf(el)
        const item = el.closest('[data-rk-item]')
        if (!h || !host || index < 0 || !item) return false
        const unit = unitOf(host)
        const within = (el.getBoundingClientRect().top - item.getBoundingClientRect().top) / unit
        const tall = el.getBoundingClientRect().height / unit + 32 >= host.clientHeight
        const offset = align === 'start' || tall ? within - (align === 'start' ? 0 : 16) : within + el.getBoundingClientRect().height / unit / 2 - host.clientHeight / 2
        pin(around(index))
        h.scrollToIndex(index, { align: 'start', offset })
        return true
      }
    })
    api.showInitial()
    return off
  }, [api])

  const check = (): void => {
    if (checking.current) return
    checking.current = requestAnimationFrame(() => {
      checking.current = 0
      const h = handle.current
      const host = hostOf()
      if (!h || !host) return
      const m = marginOf(host)
      if (Math.abs(m - margin.current) >= 1) {
        margin.current = m
        setStartMargin(m)
      }
      if (view?.blocks && !restoring && view.blocks.count === live.current.count) view.blocks = { ...view.blocks, cache: h.cache }
      const flat: number[] = []
      for (let i = 0; i < live.current.count; i++) if (h.getItemSize(i) === 0 && !remeasured.current.has(i)) flat.push(i)
      if (!flat.length) {
        setChecked(true)
        return
      }
      for (const i of flat) remeasured.current.add(i)
      console.info(`[report] ${flat.length} blocks measured 0 px tall (${flat.slice(0, 12).join(', ')}${flat.length > 12 ? ', …' : ''}), mounting them again to measure`)
      setPinned((prev) => [...new Set([...prev, ...flat])])
      window.setTimeout(() => setPinned((prev) => prev.filter((x) => !flat.includes(x))), PIN_MS)
    })
  }

  useEffect(() => {
    check()
    const t = window.setTimeout(() => setChecked(true), RESTORE_MS)
    return () => {
      cancelAnimationFrame(checking.current)
      window.clearTimeout(t)
    }
  }, [])

  const onScroll = (offset: number): void => {
    const h = handle.current
    if (!h) return
    const b = live.current.buffer
    const first = h.findItemIndex(offset - b)
    const last = h.findItemIndex(offset + h.viewportSize + b)
    setNear((prev) => (prev && prev[0] === first && prev[1] === last ? prev : [first, last]))
    const host = scroller.current
    if (restoring || !view || !host) return
    const top = host.scrollTop
    const index = h.findItemIndex(top)
    const within = top - marginOf(host) - h.getItemOffset(index)
    const prev = view.blocks
    view.blocks = { count, index, within, cache: prev && prev.count === count ? prev.cache : null }
  }

  const onScrollEnd = (): void => {
    const h = handle.current
    if (!h || !view?.blocks) return
    view.blocks = { ...view.blocks, cache: h.cache }
  }

  useEffect(
    () => () => {
      const h = handle.current
      if (!h || !view?.blocks || view.blocks.count !== live.current.count) return
      try {
        view.blocks = { ...view.blocks, cache: h.cache }
      } catch {
        return
      }
    },
    []
  )

  return (
    <div ref={listRef} className={`rk-vlist${restoring || !checked ? ' rk-restoring' : ''}`} data-rk-blocks={count}>
      {startMargin >= 0 && (
        <Virtualizer
          ref={handle}
          scrollRef={scroller}
          startMargin={startMargin}
          bufferSize={buffer}
          cache={cache}
          keepMounted={keep}
          item={Item}
          onScroll={onScroll}
          onScrollEnd={onScrollEnd}
          onResize={check}
        >
          {blocks}
        </Virtualizer>
      )}
    </div>
  )
}

export function ReportBlocks({ children }: { children: ReactElement[] }): ReactElement {
  const api = useReport()
  const scroller = api.host.scroller
  if (!scroller) return <>{children}</>
  return <VirtualBlocks api={api} blocks={children} scroller={scroller} />
}
