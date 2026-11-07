import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { useMobileBack } from '../../lib/mobile/mobile-back'
import { FIND_LIMIT, announceFind, findRanges, revealRange, scrollRangeIntoView, setFindHighlights } from '../../lib/find-in-view'
import { frameChannelsIn, type FrameChannel } from '../report/frame-host'

interface RemoteHits {
  channel: FrameChannel
  count: number
}

function revealFrame(channel: FrameChannel, stop: HTMLElement): void {
  const el = channel.iframe
  if (!el) return
  for (let p = el.parentElement; p; p = p.parentElement) {
    const box = p.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    if (p.scrollHeight > p.clientHeight + 1 && /(auto|scroll|overlay)/.test(getComputedStyle(p).overflowY)) {
      if (r.top < box.top || r.bottom > box.bottom) p.scrollTop += r.top - box.top - 24
    }
    if (p === stop) return
  }
}

const iconButton =
  'flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-white/10 hover:text-ink disabled:pointer-events-none disabled:opacity-40'

export function FindInViewBar({
  containerRef,
  rootSelector,
  focusSeq,
  onClose
}: {
  containerRef: RefObject<HTMLElement | null>
  rootSelector: string
  focusSeq: number
  onClose: () => void
}) {
  const owner = useMemo(() => Symbol('find'), [])
  useMobileBack(onClose, 'Find')
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(() => {
    const sel = window.getSelection()
    const text = sel && !sel.isCollapsed && containerRef.current?.contains(sel.anchorNode) ? sel.toString().trim() : ''
    return text && !text.includes('\n') && text.length <= 200 ? text : ''
  })
  const [ranges, setRanges] = useState<Range[]>([])
  const [remote, setRemote] = useState<RemoteHits[]>([])
  const frames = useRef<FrameChannel[]>([])
  const runSeq = useRef(0)
  const [active, setActive] = useState(0)
  const activeRef = useRef(active)
  activeRef.current = active
  const pendingScroll = useRef(false)
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    const root = containerRef.current?.querySelector<HTMLElement>(rootSelector) ?? null
    const opened = frameChannelsIn(containerRef.current)
    frames.current = opened
    let alive = true
    void Promise.all([announceFind(root, true), ...opened.map((c) => c.query({ q: 'findOpen', open: true }, 5000).catch(() => null))]).then(() => {
      if (alive) setReady(true)
    })
    return () => {
      alive = false
      void announceFind(root, false)
      for (const c of opened) void c.query({ q: 'findOpen', open: false }, 5000).catch(() => null)
    }
  }, [containerRef, rootSelector])

  const run = useCallback(() => {
    const root = containerRef.current?.querySelector<HTMLElement>(rootSelector)
    const next = root ? findRanges(root, query) : []
    const seq = ++runSeq.current
    const channels = frames.current.filter((c) => c.isReady())
    const apply = (hits: RemoteHits[]): void => {
      if (seq !== runSeq.current) return
      setRanges(next)
      setRemote(hits)
      const total = next.length + hits.reduce((n, h) => n + h.count, 0)
      setActive((a) => (total ? Math.min(a, total - 1) : 0))
    }
    if (!channels.length) {
      apply([])
      return
    }
    void Promise.all(channels.map((channel) => channel.query<number>({ q: 'find', text: query }, 5000).then((count) => ({ channel, count: Number(count) || 0 }), () => ({ channel, count: 0 })))).then(apply)
  }, [containerRef, rootSelector, query])

  useEffect(() => {
    if (!ready) return
    setActive(0)
    pendingScroll.current = true
    run()
  }, [query, ready])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let timer = 0
    const mo = new MutationObserver((records) => {
      if (records.every((r) => inputRef.current?.closest('[data-find-bar]')?.contains(r.target))) return
      window.clearTimeout(timer)
      timer = window.setTimeout(run, 150)
    })
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    const offs = frames.current.map((c) =>
      c.onFindChange(() => {
        window.clearTimeout(timer)
        timer = window.setTimeout(run, 150)
      })
    )
    return () => {
      mo.disconnect()
      offs.forEach((off) => off())
      window.clearTimeout(timer)
    }
  }, [containerRef, run, ready])

  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [focusSeq])

  useEffect(() => {
    const current = ranges[active] ?? null
    setFindHighlights(owner, ranges, current)
    const scroll = pendingScroll.current
    let offset = ranges.length
    for (const hit of remote) {
      const local = active - offset
      const mine = local >= 0 && local < hit.count
      void hit.channel.query({ q: 'findShow', index: mine ? local : -1, scroll: scroll && mine }, 5000).catch(() => null)
      if (mine && scroll && containerRef.current) revealFrame(hit.channel, containerRef.current)
      offset += hit.count
    }
    if (scroll && active >= ranges.length) pendingScroll.current = false
    if (!current || !pendingScroll.current) return
    pendingScroll.current = false
    const root = containerRef.current?.querySelector<HTMLElement>(rootSelector)
    if (!root || !containerRef.current) return
    const stop = containerRef.current
    if (revealRange(current, root)) {
      requestAnimationFrame(() => requestAnimationFrame(() => scrollRangeIntoView(current, stop)))
    } else {
      scrollRangeIntoView(current, stop)
    }
  }, [ranges, remote, active, owner, containerRef, rootSelector])

  useEffect(() => () => setFindHighlights(owner, [], null), [owner])

  const count = ranges.length + remote.reduce((n, h) => n + h.count, 0)

  const step = (dir: 1 | -1): void => {
    if (!count) return
    pendingScroll.current = true
    setActive((a) => (a + dir + count) % count)
  }

  const label = !query ? '' : count ? `${active + 1} of ${count >= FIND_LIMIT ? `${FIND_LIMIT}+` : count}` : 'No results'

  return (
    <div
      data-find-bar
      data-find-count={count}
      data-find-active={count ? active + 1 : 0}
      className="surface-overlay-sm absolute right-4 top-2 z-30 flex items-center gap-1 rounded-md py-1 pl-1.5 pr-1"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
        placeholder="Find"
        aria-label="Find in this view"
        spellCheck={false}
        className="h-6 w-52 min-w-0 rounded border border-white/10 bg-black/20 px-2 text-xs text-ink outline-none placeholder:text-ink-4 focus:border-accent/60"
      />
      <span
        className={`min-w-[4.5rem] shrink-0 px-1 text-[11px] tabular-nums ${query && !count ? 'text-rose-300' : 'text-ink-3'}`}
        aria-live="polite"
        data-find-label
      >
        {label}
      </span>
      <button type="button" className={iconButton} disabled={!count} onClick={() => step(-1)} title="Previous match (⇧Enter)" aria-label="Previous match">
        <ArrowUp size={13} strokeWidth={1.75} />
      </button>
      <button type="button" className={iconButton} disabled={!count} onClick={() => step(1)} title="Next match (Enter)" aria-label="Next match">
        <ArrowDown size={13} strokeWidth={1.75} />
      </button>
      <button type="button" className={iconButton} onClick={onClose} title="Close (Esc)" aria-label="Close find">
        <X size={13} strokeWidth={1.75} />
      </button>
    </div>
  )
}
