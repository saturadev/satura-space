import {
  Children,
  Fragment,
  Suspense,
  isValidElement,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactElement,
  type TableHTMLAttributes,
  type TdHTMLAttributes,
  type ReactNode
} from 'react'
import type * as Kit from '@satura/report'
import type { CarouselSlide, ChangeResult, ChartPoint, ChartSeries, CheckStatus, DiffRow, FileChange, LogLine, PlayerRow, ReportStatus, StepStatus, TableColumn, Tone, VideoEvent } from '@satura/report'
import type { UnityLogLine } from '@shared/api'
import { resolveReportTarget } from '@shared/report-link'
import { LogRow } from '../workbench/UnityLogRow'
import { CompareView, FramePlayer, type FramePlayerHandle } from './FramePlayer'
import { compareMode, compareRatios } from './compare-core'
import type { PlayerLogLine } from './frame-player-core'
import { ReportSavedContext, useMediaCheck, useReport, type ReportApi, type ReportGit } from './report-context'
import { Activatable } from './Activatable'
import { ExpandButton, Fullscreen } from './Fullscreen'
import { SavedChip } from './saved-chip'
import { CardFooter, CardHeader, CardRow, CardRows, CopyAction, HoverCard } from '../ui/HoverCard'
import { CodeRef, linkify, linkifyText, remarkCodeRefs } from './code-ref'
import { imageAspect, noteImageAspect } from './report-view-state'
import { fmtTime } from './zoom-pan'
import { VideoSyncContext } from './video-sync'
import { MediaWait, useMediaGate, useMediaInfo, useStreamUrls } from './media-gate'
import { useMediaZoom } from './media-zoom'
import { mediaLoader, type MediaInfo } from '../../lib/media-loader'
import { canDecodeFrames, snapFps, type FrameSource } from './frame-decoder'
import { bridgeSource, loaderSource, type LoaderSource } from './frame-sources'
import { SoundPlayer } from './sound-player'
import { SaveMedia } from './save-media'
import { ProgressBar } from '../../remote/motion'
import { cellFit, nodeText } from '../../lib/table-fit'
import { FIND_REVEAL_EVENT } from '../../lib/find-in-view'
import { ReportBlocks, blockList } from './report-blocks'

import { Status, WORKTREE_REF, type Change, type Commit } from '@shared/git-scm'

const FileDiff = lazy(() => import('./git-file-diff'))
const PhoneVideo = lazy(() => import('./phone-video').then((m) => ({ default: m.PhoneVideo })))
const MarkdownBlock = lazy(() => import('../workbench/MarkdownView').then((m) => ({ default: m.MarkdownBlock })))

function Shown({ on }: { on: () => void }): null {
  useEffect(on, [on])
  return null
}

function useShownHold(api: ReportApi): ReactElement {
  const hold = useMemo(() => ({ shown: false, done: null as (() => void) | null }), [api])
  const on = useCallback(() => {
    hold.shown = true
    const done = hold.done
    if (done) requestAnimationFrame(done)
  }, [hold])
  useEffect(() => {
    if (hold.shown) return
    const done = api.host.store.begin()
    hold.done = done
    return done
  }, [api, hold])
  return <Shown on={on} />
}

const TONE_CLASS: Record<Tone, string> = { ok: 'k-ok', info: 'k-info', warn: 'k-warn', error: 'k-error', muted: '' }
const STATUS_TONE: Record<ReportStatus, Tone> = { pass: 'ok', fail: 'error', partial: 'warn', info: 'info' }
const STATUS_LABEL: Record<ReportStatus, string> = { pass: 'Passed', fail: 'Failed', partial: 'Partly done', info: 'Info' }

const toneClass = (tone?: Tone): string => (tone ? TONE_CLASS[tone] ?? '' : '')

function Icon({ name }: { name: 'chev' | 'film' | CheckStatus }): ReactElement {
  if (name === 'chev')
    return (
      <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 6l6 6-6 6" />
      </svg>
    )
  if (name === 'film')
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M10 9.5v5l4-2.5z" fill="currentColor" />
      </svg>
    )
  const color = name === 'pass' ? 'var(--ok)' : name === 'fail' ? 'var(--error)' : 'var(--ink-3)'
  return (
    <svg className="st" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      {name === 'pass' && <path d="M8 12.5l2.8 2.8L16.5 9.5" />}
      {name === 'fail' && <path d="M9 9l6 6M15 9l-6 6" />}
      {name === 'skip' && <path d="M8 12h8" />}
    </svg>
  )
}

function Card({ title, children, style }: { title?: ReactNode; children?: ReactNode; style?: CSSProperties }): ReactElement {
  return (
    <div className="rk-card" style={style}>
      {title != null && title !== false && <div className="rk-card-title">{title}</div>}
      {children}
    </div>
  )
}

export function Report({
  title,
  subtitle,
  status,
  meta,
  children
}: {
  title: string
  subtitle?: ReactNode
  status?: ReportStatus
  meta?: ReactNode
  session?: string
  children?: ReactNode
}): ReactElement {
  const api = useReport()
  const savedAt = useContext(ReportSavedContext)
  useEffect(() => {
    api.host.setTitle(String(title ?? ''))
  }, [api, title])
  const savedSource = useMemo(() => {
    const { file, root } = api.host
    const info = api.bridge.fileInfo
    return { file, root, load: info ? () => info(file, root) : undefined }
  }, [api])
  const blocks = blockList(children)
  return (
    <ReportBlocks>
      {[
        <header key="rk-head" className="rk-head">
          <div className="rk-head-top">
            <h1 className="rk-title">{title}</h1>
            {status && STATUS_TONE[status] && <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>}
            {savedAt != null && (
              <SavedChip ms={savedAt} className="rk-when-head" source={savedSource} />
            )}
          </div>
          {subtitle != null && <div className="rk-subtitle">{subtitle}</div>}
          {meta != null && <div className="rk-meta">{meta}</div>}
        </header>,
        ...(blocks.length ? blocks : [<div key="rk-empty" className="rk-empty" data-report-empty>Nothing in this report yet</div>])
      ]}
    </ReportBlocks>
  )
}

export function Summary({ tone, children }: { tone?: Tone; children?: ReactNode }): ReactElement {
  return <div className={`rk-summary ${toneClass(tone)}`}>{linkify(children)}</div>
}

export function Section({
  title,
  description,
  children,
  style
}: {
  title?: ReactNode
  description?: ReactNode
  children?: ReactNode
  style?: CSSProperties
}): ReactElement {
  return (
    <section className="rk-section" style={style}>
      {(title != null || description != null) && (
        <div className="rk-section-head">
          {title != null && <h2 className="rk-section-title">{title}</h2>}
          {description != null && <div className="rk-section-desc">{description}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function Spoiler({ title, open = false, children }: { title: ReactNode; open?: boolean; children?: ReactNode }): ReactElement {
  return (
    <details className="rk-card rk-spoiler" open={open || undefined} data-spoiler>
      <summary className="rk-spoiler-hd">
        <Icon name="chev" />
        <span className="rk-spoiler-title">{linkify(title)}</span>
      </summary>
      <div className="rk-spoiler-bd">{children}</div>
    </details>
  )
}

export function Grid({ min = 260, gap = 12, children, style }: { min?: number; gap?: number; children?: ReactNode; style?: CSSProperties }): ReactElement {
  const m = Math.max(80, Number(min) || 260)
  return (
    <div className="rk-grid" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${m}px), 1fr))`, gap, ...style }}>
      {children}
    </div>
  )
}

const ALIGN: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', baseline: 'baseline' }
const JUSTIFY: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between' }

export function Row({
  gap = 8,
  align = 'center',
  justify = 'start',
  children,
  style
}: {
  gap?: number
  align?: 'start' | 'center' | 'end' | 'baseline'
  justify?: 'start' | 'center' | 'end' | 'between'
  children?: ReactNode
  style?: CSSProperties
}): ReactElement {
  return (
    <div className="rk-row" style={{ gap, alignItems: ALIGN[align], justifyContent: JUSTIFY[justify], ...style }}>
      {children}
    </div>
  )
}

type PopoverPlacement = 'top' | 'bottom' | 'left' | 'right'

function PopoverBody({
  title,
  rows,
  content,
  copy
}: {
  title?: ReactNode
  rows?: Record<string, ReactNode> | [ReactNode, ReactNode][]
  content?: ReactNode
  copy?: string
}): ReactElement {
  const list: [ReactNode, ReactNode][] = Array.isArray(rows) ? rows : Object.entries(rows ?? {})
  const body = content == null ? null : typeof content === 'string' ? <p className="rk-pop-text">{linkify(content)}</p> : linkify(content)
  return (
    <div className="rk-pop" data-report-popover>
      {title != null && <CardHeader title={linkify(title)} />}
      {body != null && <div className={`rk-pop-body ${title != null ? 'ruled' : ''}`}>{body}</div>}
      {list.length > 0 && (
        <CardRows>
          {list.map(([k, v], i) => (
            <CardRow key={i} label={nodeText(k)}>
              {typeof v === 'number' || typeof v === 'boolean' ? String(v) : linkify(v)}
            </CardRow>
          ))}
        </CardRows>
      )}
      {copy && (
        <CardFooter>
          <CopyAction text={copy}>Copy</CopyAction>
        </CardFooter>
      )}
    </div>
  )
}

export function Popover({
  children,
  content,
  title,
  rows,
  copy,
  placement = 'bottom'
}: {
  children: ReactNode
  content?: ReactNode
  title?: ReactNode
  rows?: Record<string, ReactNode> | [ReactNode, ReactNode][]
  copy?: string
  placement?: PopoverPlacement
}): ReactElement {
  const plain = typeof children === 'string' || typeof children === 'number'
  return (
    <HoverCard
      className={`rk-pop-trigger inline ${plain ? 'plain' : ''}`}
      layerClassName="sr-scope"
      placement={placement}
      content={() => <PopoverBody title={title} rows={rows} content={content} copy={copy} />}
      attrs={{ 'data-report-popover-trigger': '' }}
    >
      {children}
    </HoverCard>
  )
}

function withInfo(node: ReactElement, info: ReactNode, display: 'block' | 'inline'): ReactElement {
  if (info == null || info === false) return node
  return (
    <HoverCard
      className={`rk-pop-trigger ${display}`}
      layerClassName="sr-scope"
      content={() => <PopoverBody content={info} />}
      attrs={{ 'data-report-popover-trigger': '' }}
    >
      {node}
    </HoverCard>
  )
}

export function Stat({ label, value, hint, tone, info }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: Tone; info?: ReactNode }): ReactElement {
  return withInfo(
    <div className={`rk-card rk-stat ${toneClass(tone)} ${info != null ? 'has-info' : ''}`}>
      <span className="rk-stat-label">{label}</span>
      <span className="rk-stat-value">{value}</span>
      {hint != null && <span className="rk-stat-hint">{linkify(hint)}</span>}
    </div>,
    info,
    'block'
  )
}

export function Text({ children, tone, size = 'md', mono }: { children?: ReactNode; tone?: Tone; size?: 'sm' | 'md'; mono?: boolean }): ReactElement {
  return <p className={`rk-text ${size === 'sm' ? 'sm' : ''} ${mono ? 'mono' : ''} ${toneClass(tone)}`}>{linkify(children)}</p>
}

export function Badge({ tone, children, info }: { tone?: Tone; children?: ReactNode; info?: ReactNode }): ReactElement {
  return withInfo(
    <span className={`rk-badge ${toneClass(tone)} ${info != null ? 'has-info' : ''}`}>
      <span className="sr-dot" />
      {linkify(children)}
    </span>,
    info,
    'inline'
  )
}

const REMARK_EXTRA = [remarkCodeRefs]

const wrapPre = (node: ReactNode): ReactNode => <Activatable kind="scroll">{node}</Activatable>

export function Markdown({ children }: { children: string }): ReactElement {
  const api = useReport()
  const shown = useShownHold(api)
  return (
    <Suspense fallback={<div className="rk-md" />}>
      <MarkdownBlock
        content={String(children ?? '')}
        filePath={api.host.file}
        className="rk-md"
        remarkExtra={REMARK_EXTRA}
        wrapPre={wrapPre}
      />
      {shown}
    </Suspense>
  )
}

export function Code({ children, lang, title }: { children: string; lang?: string; title?: string }): ReactElement {
  const api = useReport()
  const shown = useShownHold(api)
  const text = String(children ?? '')
  const ticks = Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1))
  const fence = '`'.repeat(ticks)
  const md = `${fence}${(lang ?? '').replace(/[^\w+#.-]/g, '')}\n${text.replace(/\n$/, '')}\n${fence}`
  const body = (
    <Suspense fallback={<pre className="rk-check-log">{text}</pre>}>
      <MarkdownBlock content={md} filePath={api.host.file} className="rk-md" remarkExtra={REMARK_EXTRA} wrapPre={wrapPre} />
      {shown}
    </Suspense>
  )
  return title ? <Card title={title}>{body}</Card> : body
}

function normColumns(columns: (string | TableColumn)[]): TableColumn[] {
  return (columns ?? []).map((c) => (typeof c === 'string' ? { key: c, label: c } : { ...c, label: c.label ?? c.key }))
}

export function Table({
  columns,
  rows,
  title
}: {
  columns: (string | TableColumn)[]
  rows: (Record<string, ReactNode> | ReactNode[])[]
  title?: ReactNode
}): ReactElement {
  const cols = normColumns(columns)
  return (
    <Card title={title}>
      <Activatable kind="scroll">
      <div className="rk-table-wrap">
        <table className="rk-table">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.key} style={{ textAlign: c.align ?? 'left' }}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((row, i) => (
              <tr key={i}>
                {cols.map((c, j) => {
                  const v = Array.isArray(row) ? row[j] : (row as Record<string, ReactNode>)[c.key]
                  return (
                    <td key={c.key} className={cellFit(nodeText(v))} style={{ textAlign: c.align ?? 'left' }}>
                      {v}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </Activatable>
    </Card>
  )
}

export function RawTable(props: TableHTMLAttributes<HTMLTableElement>): ReactElement {
  return (
    <Activatable kind="scroll">
      <div className="rk-table-wrap">
        <table {...props} className={`rk-raw-table ${props.className ?? ''}`} />
      </div>
    </Activatable>
  )
}

const rawCells = new Map<'td' | 'th', (props: TdHTMLAttributes<HTMLTableCellElement>) => ReactElement>()

export function RawCell(tag: 'td' | 'th'): (props: TdHTMLAttributes<HTMLTableCellElement>) => ReactElement {
  let C = rawCells.get(tag)
  if (!C) {
    const Tag = tag
    C = (props) => <Tag {...props} className={`${cellFit(nodeText(props.children))} ${props.className ?? ''}`} />
    rawCells.set(tag, C)
  }
  return C
}

function frameLabel(frame?: number, t?: number): string {
  if (frame != null) return `F ${frame}`
  if (t != null) return fmtTime(t).replace(/^0/, '')
  return 'Open'
}

export function FrameLink({
  video,
  frame,
  t,
  report,
  children
}: {
  video?: string
  frame?: number
  t?: number
  report?: string
  children?: ReactNode
}): ReactElement {
  const api = useReport()
  const [lost, setLost] = useState(false)
  useEffect(() => {
    if (!lost) return
    const t = window.setTimeout(() => setLost(false), 4000)
    return () => window.clearTimeout(t)
  }, [lost])
  const go = (): void => {
    if (report) {
      api.host.openReport(resolveReportTarget(api.host.file, report), { video, frame, t })
      return
    }
    const what = `FrameLink "${typeof children === 'string' ? children.slice(0, 60) : frameLabel(frame, t)}"`
    if (api.goto({ video, frame, t }, what)) return
    window.setTimeout(() => {
      if (api.hasVideo(video)) return
      api.diag(what, { video, frame, t }, `no video ${video ?? ''} (registered: ${api.videoIds()})`)
      setLost(true)
      api.host.store.warn(`No video "${video ?? ''}" in this report for a frame link`)
    }, 1500)
  }
  return (
    <button
      type="button"
      className={`rk-flink ${lost ? 'lost' : ''}`}
      data-frame-link={frame ?? t ?? ''}
      title={report ? `Open ${report}` : lost ? `This report has no video called ${video ?? ''}` : 'Show this frame'}
      onClick={(e) => {
        e.stopPropagation()
        go()
      }}
    >
      <Icon name="film" />
      {children ?? frameLabel(frame, t)}
    </button>
  )
}

interface CheckProps {
  name: string
  status: CheckStatus
  detail?: ReactNode
  group?: string
  ms?: number
  log?: string | string[]
  video?: string
  frame?: number
  t?: number
  report?: string
  children?: ReactNode
}

function useFindReveal(reveal: (() => void) | null): (el: HTMLElement | null) => void {
  const fn = useRef(reveal)
  fn.current = reveal
  const [el, setEl] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!el) return
    const on = (): void => fn.current?.()
    el.addEventListener(FIND_REVEAL_EVENT, on)
    return () => el.removeEventListener(FIND_REVEAL_EVENT, on)
  }, [el])
  return setEl
}

function msLabel(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`
}

function CheckRow({ c, open, onToggle }: { c: CheckProps; open: boolean; onToggle: () => void }): ReactElement {
  const logText = Array.isArray(c.log) ? c.log.join('\n') : (c.log ?? '')
  const hasBody = c.detail != null || !!logText || c.children != null
  const linked = c.frame != null || c.t != null || !!c.report
  const status: CheckStatus = c.status === 'pass' || c.status === 'fail' ? c.status : 'skip'
  const revealRef = useFindReveal(open ? null : onToggle)
  return (
    <div className={`rk-check ${open && hasBody ? 'open' : ''}`} data-check={status}>
      <div className={`rk-check-hd ${hasBody ? '' : 'static'}`} onClick={hasBody ? onToggle : undefined}>
        {hasBody ? <Icon name="chev" /> : <span />}
        <Icon name={status} />
        <span className="rk-check-name" title={c.name}>
          {c.name}
          {c.group && <small>{c.group}</small>}
        </span>
        {linked ? <FrameLink video={c.video} frame={c.frame} t={c.t} report={c.report} /> : <span />}
        <span className="rk-check-ms">{msLabel(c.ms)}</span>
      </div>
      {hasBody && (
        <div className="rk-check-bd" hidden={!open} data-find-reveal={open ? undefined : ''} ref={revealRef}>
          {c.detail != null && <div className="rk-check-detail">{linkify(c.detail)}</div>}
          {logText && (
            <Activatable kind="scroll">
              <pre className="rk-check-log">{logText.split('\n').map((ln, i) => <span key={i}>{i > 0 && '\n'}{linkifyText(ln, `l${i}`)}</span>)}</pre>
            </Activatable>
          )}
          {open && c.children}
        </div>
      )}
    </div>
  )
}

function flatten(children: ReactNode): ReactNode[] {
  const out: ReactNode[] = []
  for (const child of Children.toArray(children)) {
    if (isValidElement(child) && child.type === Fragment) out.push(...flatten((child.props as { children?: ReactNode }).children))
    else out.push(child)
  }
  return out
}

export function Check(props: CheckProps): ReactElement {
  const [open, setOpen] = useState(props.status === 'fail')
  return (
    <div className="rk-card">
      <CheckRow c={props} open={open} onToggle={() => setOpen((o) => !o)} />
    </div>
  )
}

type CheckFilter = 'all' | 'fail' | 'pass'

export function Checks({ title, children }: { title?: ReactNode; children?: ReactNode }): ReactElement {
  const nodes = flatten(children)
  const items = nodes.filter((n): n is ReactElement<CheckProps> => isValidElement(n) && n.type === Check).map((n) => n.props)
  const rest = nodes.filter((n) => !(isValidElement(n) && n.type === Check))
  const api = useReport()
  const id = `checks:${typeof title === 'string' ? title : ''}:${items.map((c) => c.name).join('|')}`
  const [filter, setFilter] = api.usePersisted<CheckFilter>(`${id}.filter`, () => 'all')
  const [toggledList, setToggledList] = api.usePersisted<number[]>(`${id}.open`, () => [])
  const toggled = useMemo(() => new Set(toggledList), [toggledList])
  const setToggled = (fn: (prev: Set<number>) => Set<number>): void => setToggledList((prev) => [...fn(new Set(prev))])
  const count = { pass: 0, fail: 0, skip: 0 }
  for (const c of items) count[c.status === 'pass' || c.status === 'fail' ? c.status : 'skip']++
  const total = items.length || 1
  const shown = items.map((c, i) => ({ c, i })).filter(({ c }) => filter === 'all' || c.status === filter)
  const isOpen = (i: number): boolean => (items[i].status === 'fail') !== toggled.has(i)
  return (
    <Card title={title}>
      <div className="rk-checks-bar">
        <div className="rk-checks-sum">
          <span>
            <span className="sr-dot k-ok" />
            {count.pass} passed
          </span>
          <span>
            <span className="sr-dot k-error" />
            {count.fail} failed
          </span>
          {count.skip > 0 && (
            <span>
              <span className="sr-dot" style={{ background: 'var(--ink-3)' }} />
              {count.skip} skipped
            </span>
          )}
        </div>
        <div className="rk-ratio">
          <i style={{ width: `${(count.pass / total) * 100}%`, background: 'var(--ok)' }} />
          <i style={{ width: `${(count.fail / total) * 100}%`, background: 'var(--error)' }} />
          <i style={{ width: `${(count.skip / total) * 100}%`, background: 'var(--ink-4)' }} />
        </div>
        <span className="sr-spacer" />
        <div className="sr-seg">
          {(['all', 'fail', 'pass'] as const).map((f) => (
            <button key={f} type="button" className={`sr-btn ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'fail' ? 'Failed' : 'Passed'}
            </button>
          ))}
        </div>
      </div>
      {shown.length ? (
        shown.map(({ c, i }) => (
          <CheckRow
            key={i}
            c={c}
            open={isOpen(i)}
            onToggle={() =>
              setToggled((prev) => {
                const next = new Set(prev)
                if (next.has(i)) next.delete(i)
                else next.add(i)
                return next
              })
            }
          />
        ))
      ) : (
        <div className="rk-empty">{items.length ? 'No checks match this filter' : 'No checks yet'}</div>
      )}
      {rest}
    </Card>
  )
}

interface VideoProps {
  src: string
  id?: string
  title?: ReactNode
  label?: string
  fps?: number
  events?: VideoEvent[]
  log?: LogLine[]
  height?: number
  offset?: number
  frames?: boolean
}

const playerHeight = (h: number): string => `min(${h}px, max(260px, calc(100cqh - 32px)))`

const phoneVideoBox = (info: MediaInfo | null | undefined, h: number): CSSProperties => ({
  width: '100%',
  maxHeight: playerHeight(h),
  aspectRatio: String(info && info.width > 0 && info.height > 0 ? info.width / info.height : 16 / 9),
  minHeight: 0,
  overflow: 'hidden'
})

function toPlayerLog(log?: LogLine[], prefix = ''): PlayerLogLine[] {
  return (log ?? []).map((l) => ({ msg: `${prefix}${String(l.msg ?? '')}`, level: l.level, frame: l.frame, t: l.t, src: l.src }))
}

const decodable = new Map<string, boolean>()

function useDecodable(codec: string | undefined, wanted: boolean): boolean | null {
  const key = codec ?? ''
  const [got, setGot] = useState<{ key: string; ok: boolean } | null>(() => (decodable.has(key) ? { key, ok: decodable.get(key)! } : null))
  useEffect(() => {
    if (!wanted || decodable.has(key)) return
    let alive = true
    void canDecodeFrames(codec).then((ok) => {
      decodable.set(key, ok)
      if (alive) setGot({ key, ok })
    })
    return () => {
      alive = false
    }
  }, [key, wanted])
  if (!wanted) return false
  if (decodable.has(key)) return decodable.get(key)!
  return got?.key === key ? got.ok : null
}

type PlayerKind = 'frames' | 'sound'

const infoFps = (info: MediaInfo | null | undefined): number | undefined => (info?.fps ? snapFps(info.fps) : undefined)

function kindOf(frames: boolean | undefined, info: MediaInfo | null | undefined): PlayerKind {
  if (frames != null) return frames ? 'frames' : 'sound'
  return info?.audio ? 'sound' : 'frames'
}

function videoLog(api: ReportApi): (line: string) => void {
  return (line) => {
    console.info(line)
    if (onPhone(api)) mediaLoader()?.note?.(line)
    else api.bridge.diag?.(line)
  }
}

function useBridgeSource(api: ReportApi, src: string, on: boolean): FrameSource | null {
  return useMemo(() => {
    const read = api.bridge.mediaRead
    if (!on || !read || mediaLoader()) return null
    const path = api.path(src)
    return bridgeSource(path, (offset, length) => read(api.host.file, api.host.root, path, offset, length))
  }, [api, src, on])
}

function ExpandablePlayer({
  name,
  title,
  height,
  register,
  player
}: {
  name: string
  title?: ReactNode
  height: number
  register: (h: FramePlayerHandle | null) => void
  player: Omit<ComponentProps<typeof FramePlayer>, 'onHandle' | 'onExpand' | 'fullscreen' | 'style' | 'onError'>
}): ReactElement {
  const api = useReport()
  const [error, setError] = useState<string | null>(null)
  useEffect(() => (error ? api.host.store.warn(error) : undefined), [api, error])
  const [full, setFull] = useState(false)
  const [fullBody, setFullBody] = useState<HTMLDivElement | null>(null)
  return (
    <>
      {full && (
        <div className="rk-fs-away" style={{ height: playerHeight(height) }}>
          <span>Playing in full screen</span>
          <button type="button" className="sr-btn on" onClick={() => setFull(false)}>
            Show it here
          </button>
        </div>
      )}
      <Activatable kind="control">
        <FramePlayer
          {...player}
          onError={setError}
          onHandle={register}
          onExpand={() => setFull((f) => !f)}
          fullscreen={full ? fullBody : null}
          style={{ height: playerHeight(height) }}
        />
      </Activatable>
      {full && <Fullscreen kind="video" title={title ?? name} bodyRef={setFullBody} onClose={() => setFull(false)} />}
    </>
  )
}

function SoundCard({ src, id, title, fps, events, log, height, info }: VideoProps & { info: MediaInfo | null | undefined }): ReactElement {
  const api = useReport()
  const key = id ?? src
  const name = src.split('/').pop() || src
  const rate = fps ?? infoFps(info) ?? 30
  const h = Math.max(220, Number(height) || 460)
  const playerLog = useMemo(() => toPlayerLog(log), [log])
  const unregister = useMemo(() => ({ current: null as (() => void) | null }), [])
  const handle = useRef<FramePlayerHandle | null>(null)
  const [full, setFull] = useState(false)
  const [fullBody, setFullBody] = useState<HTMLDivElement | null>(null)
  const onLog = useMemo(() => videoLog(api), [api])
  const ratio = info && info.width > 0 && info.height > 0 ? info.width / info.height : 16 / 9
  return (
    <Card title={title}>
      <div className="sv-card">
        {full && (
          <div className="rk-fs-away" style={{ height: playerHeight(h) }}>
            <span>Playing in full screen</span>
            <button type="button" className="sr-btn on" onClick={() => setFull(false)}>
              Show it here
            </button>
          </div>
        )}
        <Activatable kind="control">
          <SoundPlayer
            src={api.url(src)}
            name={name}
            fps={rate}
            aspect={ratio}
            initialFrame={api.initialFrame(key)}
            onFrame={(f) => api.noteFrame(key, f)}
            onLog={onLog}
            onExpand={() => setFull((f) => !f)}
            fullscreen={full ? fullBody : null}
            style={{ maxHeight: playerHeight(h), width: `min(100%, calc(${playerHeight(h)} * ${ratio}))`, margin: '0 auto' }}
            onHandle={(hd) => {
              handle.current = hd
              unregister.current?.()
              unregister.current = hd ? api.registerVideo(key, hd) : null
            }}
          />
        </Activatable>
        {full && <Fullscreen kind="video" title={title ?? name} bodyRef={setFullBody} onClose={() => setFull(false)} />}
        <div className="rk-media-acts">
          <SaveMedia ask={{ path: api.path(src), name, kind: 'video' }} />
        </div>
        {!!(events?.length || playerLog.length) && <MomentList events={events ?? []} log={playerLog} fps={rate} onSeek={(t) => handle.current?.goto({ t }, true)} />}
      </div>
    </Card>
  )
}

function MomentList({ events, log, onSeek, fps }: { events: VideoEvent[]; log: PlayerLogLine[]; fps: number; onSeek: (t: number) => void }): ReactElement | null {
  const rows = useMemo(() => {
    const at = (r: { frame?: number; t?: number }): number | null => r.t ?? (r.frame != null ? r.frame / fps : null)
    return [...events.map((e) => ({ t: at(e), text: e.label, kind: e.kind ?? 'info' })), ...log.map((l) => ({ t: at(l), text: l.msg, kind: l.level ?? 'info' }))].sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity))
  }, [events, log, fps])
  if (!rows.length) return null
  return (
    <div className="pv-events">
      {rows.map((r, i) =>
        r.t != null ? (
          <button key={i} type="button" className="pv-ev" data-kind={r.kind} onClick={() => onSeek(r.t!)}>
            <span className="pv-ev-t">{fmtTime(r.t)}</span>
            <span className="pv-ev-l">{r.text}</span>
          </button>
        ) : (
          <div key={i} className="pv-ev" data-kind={r.kind}>
            <span className="pv-ev-t" />
            <span className="pv-ev-l">{r.text}</span>
          </div>
        )
      )}
    </div>
  )
}

function PhoneVideoCard({ src, id, title, fps, events, log, height, frames }: VideoProps): ReactElement {
  const api = useReport()
  const group = useContext(VideoSyncContext)
  const key = id ?? src
  const missing = useMediaCheck(api, [src])
  const h = Math.max(220, Number(height) || group?.height || (events?.length || log?.length ? 540 : 460))
  const meta = useMediaInfo(api, missing ? [] : [src], true)
  const info = meta.infos[0]
  const wantFrames = meta.ready && kindOf(frames, info) === 'frames'
  const canFrames = useDecodable(info?.codec, wantFrames)
  const playerLog = useMemo(() => toPlayerLog(log), [log])
  const unregister = useMemo(() => ({ current: null as (() => void) | null }), [])
  const shown = useShownHold(api)
  const box = phoneVideoBox(info, h)
  const mode: PlayerKind | null = !meta.ready ? null : wantFrames ? (canFrames == null ? null : canFrames ? 'frames' : 'sound') : 'sound'
  return (
    <Card title={title}>
      {!!(missing || meta.error) && shown}
      {missing ? (
        <div className="rk-missing">{missing}</div>
      ) : meta.error ? (
        <MediaWait style={box} label={`Loading ${src.split('/').pop() || 'the video'}`} error={meta.error} onRetry={meta.retry} />
      ) : !mode ? (
        <MediaWait style={box} label={`Loading ${src.split('/').pop() || 'the video'}`} />
      ) : (
        <Suspense fallback={<MediaWait style={box} label={`Loading ${src.split('/').pop() || 'the video'}`} />}>
        <PhoneVideo
          path={api.path(src)}
          ready={meta.ready}
          mode={mode}
          aspect={info ? info.width / info.height : undefined}
          duration={info?.duration}
          fps={fps ?? infoFps(info)}
          events={events}
          log={playerLog}
          initialFrame={api.initialFrame(key)}
          onFrame={(f) => api.noteFrame(key, f)}
          onHandle={(hd) => {
            unregister.current?.()
            unregister.current = hd ? api.registerVideo(key, hd) : null
          }}
          style={box}
          framesHeight={playerHeight(h)}
        />
        {shown}
        </Suspense>
      )}
    </Card>
  )
}

const onPhone = (api: ReportApi): boolean => !api.host.mediaUrl && !!mediaLoader()?.plan

export function Video(props: VideoProps): ReactElement {
  const api = useReport()
  return onPhone(api) ? <PhoneVideoCard {...props} /> : <DesktopVideo {...props} />
}

function DesktopVideo(props: VideoProps): ReactElement {
  const { src, id, title, fps, events, log, height, frames } = props
  const api = useReport()
  const group = useContext(VideoSyncContext)
  const key = id ?? src
  const missing = useMediaCheck(api, [src])
  const h = Math.max(220, Number(height) || group?.height || (events?.length || log?.length ? 540 : 460))
  const meta = useMediaInfo(api, missing ? [] : [src], true)
  const info = meta.infos[0]
  const kind = kindOf(frames, info)
  const source = useBridgeSource(api, src, kind === 'frames')
  const canFrames = useDecodable(info?.codec ?? 'avc1.42e01e', !!source && meta.ready)
  const stream = useStreamUrls(api, missing ? [] : [src])
  const wait = useMediaGate(api, missing || stream || source ? [] : [src], { height: playerHeight(h) })
  const playerLog = useMemo(() => toPlayerLog(log), [log])
  const unregister = useMemo(() => ({ current: null as (() => void) | null }), [])
  const onLog = useMemo(() => videoLog(api), [api])
  if (meta.ready && kind === 'sound' && !missing) return <SoundCard {...props} info={info} />
  return (
    <Card title={title}>
      {missing ? (
        <div className="rk-missing">{missing}</div>
      ) : !meta.ready || (source && canFrames == null) ? (
        <MediaWait style={{ height: playerHeight(h) }} label={`Loading ${src.split('/').pop() || 'the video'}`} error={meta.error} onRetry={meta.retry} />
      ) : (
        wait ?? (
        <ExpandablePlayer
          name={src.split('/').pop() || src}
          title={title}
          height={h}
          register={(hd) => {
            unregister.current?.()
            unregister.current = hd ? api.registerVideo(key, hd) : null
          }}
          player={{
            src: stream?.[0] ?? api.url(src),
            source: canFrames ? source : null,
            fps: fps ?? infoFps(info),
            aspect: info ? info.width / info.height : undefined,
            events,
            log: playerLog,
            initialFrame: api.initialFrame(key),
            onFrame: (f) => api.noteFrame(key, f),
            onLog
          }}
        />
        )
      )}
      {!missing && meta.ready && (
        <div className="rk-media-acts">
          <SaveMedia ask={{ path: api.path(src), name: src.split('/').pop() || src, kind: 'video' }} />
        </div>
      )}
    </Card>
  )
}

const nodeLabel = (v: VideoProps, i: number): string =>
  v.label || (typeof v.title === 'string' || typeof v.title === 'number' ? String(v.title) : '') || v.src.split('/').pop()?.replace(/\.[^.]+$/, '') || `Angle ${i + 1}`

function useNearBox(on: boolean): [boolean, (el: HTMLDivElement | null) => void] {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [near, setNear] = useState(!on)
  useEffect(() => {
    if (!on || !el || near) return
    const root = el.closest('.rk-host')
    const io = new IntersectionObserver((list) => list[list.length - 1].isIntersecting && setNear(true), { root: root instanceof HTMLElement ? root : null, rootMargin: '800px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [on, el, near])
  return [near, setEl]
}

function SyncedVideos({ title, height, items }: { title?: ReactNode; height?: number; items: VideoProps[] }): ReactElement {
  const api = useReport()
  const missing = useMediaCheck(api, items.map((v) => v.src))
  const main = items[0]
  const base = Number(main.offset) || 0
  const fps = main.fps
  const key = items.map((v) => v.id ?? v.src).join('|')
  const labels = items.map(nodeLabel)
  const rels = items.map((v) => (Number(v.offset) || 0) - base)
  const many = items.filter((v) => v.events?.length || v.log?.length).length > 1
  const shift = (rel: number, f?: number, t?: number): { frame?: number; t?: number } => {
    if (!rel) return { frame: f, t }
    if (t != null) return { t: t - rel }
    return f != null ? { t: f / (fps || 30) - rel } : {}
  }
  const dataKey = JSON.stringify(items.map((v) => [v.events, v.log, v.offset, v.label]))
  const merged = useMemo(() => {
    const events: VideoEvent[] = []
    const log: PlayerLogLine[] = []
    items.forEach((v, i) => {
      const pre = many ? `${labels[i]}: ` : ''
      for (const e of v.events ?? []) events.push({ ...e, label: `${pre}${e.label}`, ...shift(rels[i], e.frame, e.t) })
      for (const l of toPlayerLog(v.log, pre)) log.push({ ...l, ...shift(rels[i], l.frame, l.t) })
    })
    return { events, log }
  }, [dataKey])
  const meta = useMediaInfo(api, missing ? [] : items.map((v) => v.src), true)
  const phone = !api.host.mediaUrl && !!mediaLoader()?.read
  const h = Math.max(260, Number(height) || Number(main.height) || (items.length > 2 ? 620 : 540))
  const [near, setNearBox] = useNearBox(phone)
  const [dl, setDl] = useState<{ got: number; total: number; error: string }>({ got: 0, total: 0, error: '' })
  const srcKey = items.map((v) => v.src).join('\n')
  const sources = useMemo<(FrameSource | null)[]>(() => {
    const read = api.bridge.mediaRead
    if (phone) {
      const per = new Map<number, { got: number; total: number }>()
      let last = 0
      const sum = (force: boolean): void => {
        const now = performance.now()
        if (!force && now - last < 250) return
        last = now
        let got = 0
        let total = 0
        for (const v of per.values()) {
          got += v.got
          total += v.total
        }
        setDl((d) => ({ ...d, got, total }))
      }
      return items.map((v, i) =>
        loaderSource(api.path(v.src), true, {
          tag: { of: api.path(v.src), q: 'best' },
          progress: (got, total) => {
            per.set(i, { got, total })
            sum(got >= total)
          },
          failed: (why) => setDl((d) => ({ ...d, error: `Couldn't load ${v.src.split('/').pop()} from your desktop. ${why}` }))
        })
      )
    }
    if (!read || mediaLoader()) return items.map(() => null)
    return items.map((v) => {
      const path = api.path(v.src)
      return bridgeSource(path, (offset, length) => read(api.host.file, api.host.root, path, offset, length))
    })
  }, [api, srcKey, phone])
  useEffect(() => () => sources.forEach((s) => (s as LoaderSource | null)?.stop?.('the videos left the report')), [sources])
  const decoded = sources.every(Boolean)
  const canFrames = useDecodable(meta.infos[0]?.codec ?? 'avc1.42e01e', decoded && meta.ready)
  const useDecoded = decoded && !!canFrames
  const stream = useStreamUrls(api, missing || decoded ? [] : items.map((v) => v.src))
  const wait = useMediaGate(api, missing || stream || decoded ? [] : items.map((v) => v.src), { height: '100%' })
  const lazy = !api.host.mediaUrl && !!mediaLoader() && !decoded
  const urlOf = (i: number): string => (wait || phone ? '' : (stream?.[i] ?? api.url(items[i].src)))
  const urls = items.map((_, i) => urlOf(i)).join('\n')
  const angles = useMemo(() => items.slice(1).map((_, k) => ({ src: urlOf(k + 1), source: useDecoded ? sources[k + 1] : null, label: labels[k + 1], offset: rels[k + 1] })), [api, dataKey, key, urls, sources, useDecoded])
  const unregister = useMemo(() => ({ current: [] as (() => void)[] }), [])
  const onLog = useMemo(() => videoLog(api), [api])
  const info = meta.infos[0]
  const player = (
    <ExpandablePlayer
      name={labels.join(' · ')}
      title={title}
      height={h}
      register={(hd) => {
        unregister.current.forEach((off) => off())
        unregister.current = []
        if (!hd || wait) return
        unregister.current.push(api.registerVideo(key, hd))
        items.forEach((v, i) => {
          const rel = rels[i]
          const wrapped: FramePlayerHandle = {
            goto: (loc, pause) => hd.goto(shift(rel, loc.frame, loc.t), pause),
            element: hd.element,
            fps: hd.fps,
            frame: () => hd.frame() + Math.round(rel * hd.fps()),
            pulse: hd.pulse,
            target: () => hd.element()?.querySelector<HTMLElement>(`[data-angle="${i}"]`) ?? null
          }
          unregister.current.push(api.registerVideo(v.id ?? v.src, wrapped))
        })
      }}
      player={{
        src: urlOf(0),
        source: useDecoded ? sources[0] : null,
        fps: fps ?? infoFps(info) ?? (wait ? 30 : undefined),
        aspect: info ? info.width / info.height : undefined,
        label: labels[0],
        angles,
        events: merged.events,
        log: merged.log,
        initialFrame: api.initialFrame(key),
        onFrame: (f) => api.noteFrame(key, f),
        onLog
      }}
    />
  )
  const loading = phone && dl.total > 0 && dl.got < dl.total
  return (
    <Card title={title}>
      {missing ? (
        <div className="rk-missing">{missing}</div>
      ) : !meta.ready || (decoded && canFrames == null) || !near ? (
        <div ref={setNearBox}>
          <MediaWait style={{ height: playerHeight(h) }} label={`Loading ${items.length} videos`} error={meta.error} onRetry={meta.retry} />
        </div>
      ) : phone && !useDecoded ? (
        <MediaWait style={{ height: playerHeight(h) }} label={`Loading ${items.length} videos`} error="This phone can't decode these videos frame by frame." />
      ) : lazy ? (
        <div className="rk-gate-box">
          {player}
          {wait && <div className="rk-gate-over">{wait}</div>}
        </div>
      ) : (
        <>
          {player}
          {phone && (loading || dl.error) && (
            <div className="pv-status" data-pv-status={dl.error ? 'error' : 'downloading'} data-pv-have={dl.got} data-pv-size={dl.total}>
              <span className="pv-status-text">{dl.error || `Downloading ${items.length} videos · ${(dl.got / 1e6).toFixed(1)} of ${(dl.total / 1e6).toFixed(1)} MB`}</span>
              {!dl.error && <ProgressBar value={dl.total ? dl.got / dl.total : 0} className="pv-status-bar" />}
            </div>
          )}
        </>
      )}
      {!missing && (
        <div className="rk-media-acts">
          {items.map((v, i) => {
            const p = api.path(v.src)
            return <SaveMedia key={`${v.src}:${i}`} label={items.length > 1 ? `Save ${labels[i]}` : 'Save'} ask={{ path: p, name: v.src.split('/').pop() || v.src, kind: 'video', ...(phone ? { tag: { of: p, q: 'best' as const } } : {}) }} />
          })}
        </div>
      )}
    </Card>
  )
}

const ERROR_RE = /\b(error|exception|failed|fail)\b/i
const WARN_RE = /\bwarn(ing)?\b/i

function toLines(lines: LogLine[] | string): LogLine[] {
  if (typeof lines === 'string')
    return lines
      .replace(/\n$/, '')
      .split('\n')
      .map((msg) => ({ msg, level: ERROR_RE.test(msg) ? 'error' : WARN_RE.test(msg) ? 'warn' : 'info' }))
  return Array.isArray(lines) ? lines : []
}

const MAX_LOG_LINES = 5000

export function Log({ lines, title, video, height }: { lines: LogLine[] | string; title?: ReactNode; video?: string; height?: number }): ReactElement {
  const api = useReport()
  const all = useMemo(() => toLines(lines), [lines])
  const list = all.length > MAX_LOG_LINES ? all.slice(-MAX_LOG_LINES) : all
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const [fps, setFps] = useState<number | undefined>(undefined)
  const [frame, setFrame] = useState<number | null>(null)
  const linked = list.some((l) => l.frame != null || l.t != null)
  useEffect(() => {
    if (!linked) return
    const read = (): void => setFps(api.fps(video))
    const t = window.setTimeout(read, 0)
    const off = api.subscribe(video ? api.videoKey(video) ?? video : undefined, (f) => {
      setFrame(f)
      read()
    })
    return () => {
      window.clearTimeout(t)
      off()
    }
  }, [api, video, linked])
  const frameOf = (l: LogLine): number | null => (l.frame != null ? l.frame : l.t != null && fps ? Math.floor(l.t * fps) : null)
  const rows = list.map((l, i) => {
    const f = frameOf(l)
    const line: UnityLogLine = {
      seq: i,
      severity: l.level === 'error' ? 'error' : l.level === 'warn' ? 'warn' : 'log',
      frame: f ?? -1,
      time: l.t ?? 0,
      message: l.src ? `[${l.src}] ${String(l.msg ?? '')}` : String(l.msg ?? ''),
      stack: l.stack
    }
    return { line, f, l }
  })
  let cur = -1
  if (frame != null) rows.forEach((r, i) => r.f != null && r.f <= frame && (cur = i))
  const open = (rel: string, line: number): void => {
    api.host.showCode({ ref: rel, line })
  }
  return (
    <Card title={title ?? (all.length > MAX_LOG_LINES ? `Last ${MAX_LOG_LINES} of ${all.length} lines` : undefined)}>
      <Activatable kind="scroll">
      <div className="rk-log" style={{ maxHeight: Math.max(120, Number(height) || 320) }}>
        {rows.map(({ line, f, l }, i) => (
          <div
            key={i}
            className={`rk-log-row ${f != null ? 'linked' : ''} ${frame != null && f != null && f > frame ? 'future' : ''} ${i === cur ? 'cur' : ''}`}
            data-log-frame={f ?? ''}
            onClick={() => {
              if (window.getSelection()?.toString()) return
              if (f != null || l.t != null) api.goto({ video, frame: l.frame, t: l.frame == null ? l.t : undefined })
            }}
          >
            <LogRow
              line={line}
              count={1}
              pulse={false}
              expanded={expanded.has(i)}
              onToggle={() =>
                setExpanded((prev) => {
                  const next = new Set(prev)
                  if (next.has(i)) next.delete(i)
                  else next.add(i)
                  return next
                })
              }
              onOpen={open}
            />
          </div>
        ))}
        {!rows.length && <div className="rk-empty">No log lines</div>}
      </div>
      </Activatable>
    </Card>
  )
}

function naturalSize(url: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new window.Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = url
  })
}

function useCompareSizes(api: ReportApi, before: string | null, after: string | null, infos: (MediaInfo | null)[]): number | undefined {
  const [aspect, setAspect] = useState<number | undefined>(undefined)
  const probe = !!(!api.host.mediaUrl && mediaLoader()?.info)
  const [ia, ib] = infos
  const known = ia && ib ? `${ia.width}x${ia.height} ${ib.width}x${ib.height}` : ''
  useEffect(() => {
    if (!before || !after) return
    const warn = (a: { w: number; h: number }, b: { w: number; h: number }): (() => void) =>
      api.host.store.warn(
        `Compare: ${before} is ${a.w}x${a.h} but ${after} is ${b.w}x${b.h}, so ${after} is stretched to ${a.w}x${a.h}. Use two images of the same size.`
      )
    if (probe) {
      if (!ia || !ib || (ia.width === ib.width && ia.height === ib.height)) return
      return warn({ w: ia.width, h: ia.height }, { w: ib.width, h: ib.height })
    }
    let alive = true
    let unwarn: (() => void) | null = null
    const done = api.host.store.begin()
    void Promise.all([api.resolve(before).then(naturalSize, () => null), api.resolve(after).then(naturalSize, () => null)])
      .then(([a, b]) => {
        if (alive && a && a.h > 0) setAspect(a.w / a.h)
        if (!alive || !a || !b || (a.w === b.w && a.h === b.h)) return
        unwarn = warn(a, b)
      })
      .finally(done)
    return () => {
      alive = false
      done()
      unwarn?.()
    }
  }, [api, before, after, probe, known])
  if (probe) return ia && ia.width > 0 && ia.height > 0 ? ia.width / ia.height : undefined
  return aspect
}

export function Compare({
  before,
  after,
  beforeLabel,
  afterLabel,
  mode,
  title,
  height
}: {
  before: string
  after: string
  beforeLabel?: string
  afterLabel?: string
  mode?: 'wipe' | 'side' | 'flip' | 'diff'
  title?: ReactNode
  height?: number
}): ReactElement {
  const api = useReport()
  const missing = useMediaCheck(api, [before, after])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => (error ? api.host.store.warn(error) : undefined), [api, error])
  const meta = useMediaInfo(api, missing ? [] : [before, after])
  const measured = useCompareSizes(api, missing ? null : before, missing ? null : after, meta.infos)
  const first = meta.infos[0]
  const aspect = measured ?? (first ? first.width / first.height : undefined)
  const wait = useMediaGate(api, missing ? [] : [before, after], { width: '100%', height: '100%', borderRadius: 0 })
  const maxH = Number(height) > 0 ? ({ '--src-max': `${Math.max(160, Number(height))}px` } as CSSProperties) : undefined
  const shownMode = compareMode(mode)
  return (
    <Card title={title}>
      {missing ? (
        <div className="rk-missing">{missing}</div>
      ) : meta.error ? (
        <MediaWait style={{ height: Number(height) || 320 }} label="" error={meta.error} onRetry={meta.retry} />
      ) : wait ? (
        <div className="sr-scope sr-compare rk-auto" style={{ ...maxH, ...compareRatios(aspect, shownMode) } as CSSProperties} data-mode={shownMode} data-media-placeholder>
          <div className="src">
            <div className="src-bar" style={{ visibility: 'hidden' }}>
              <div className="sr-seg">
                <button className="sr-btn" tabIndex={-1} type="button">
                  Wipe
                </button>
              </div>
              <span className="sr-spacer" />
              <span className="sr-chip">Fit</span>
            </div>
            <div className="src-stage">{wait}</div>
          </div>
        </div>
      ) : (
        (
        <Activatable kind="control">
        <CompareView
          before={api.url(before)}
          after={api.url(after)}
          beforeLabel={beforeLabel}
          afterLabel={afterLabel}
          mode={mode}
          aspect={aspect}
          onError={setError}
          className="rk-auto"
          style={maxH}
        />
        </Activatable>
        )
      )}
    </Card>
  )
}

interface ChangeProps {
  name: string
  before: ReactNode
  after: ReactNode
  result?: ChangeResult
  better?: 'lower' | 'higher'
  unit?: string
  detail?: ReactNode
  video?: string
  beforeVideo?: string
  afterVideo?: string
  beforeFrame?: number
  beforeT?: number
  afterFrame?: number
  afterT?: number
  beforeImage?: string
  afterImage?: string
}

const RESULT_TONE: Record<ChangeResult, Tone> = { fixed: 'ok', better: 'ok', same: 'muted', worse: 'error' }
const RESULT_LABEL: Record<ChangeResult, string> = { fixed: 'Fixed', better: 'Better', same: 'No change', worse: 'Worse' }
const RESULTS: ChangeResult[] = ['fixed', 'better', 'same', 'worse']

function changeResult(c: ChangeProps): ChangeResult | undefined {
  if (c.result && RESULT_TONE[c.result]) return c.result
  if (typeof c.before !== 'number' || typeof c.after !== 'number' || !c.better) return undefined
  if (c.before === c.after) return 'same'
  return (c.after < c.before) === (c.better === 'lower') ? 'better' : 'worse'
}

function changeDelta(c: ChangeProps): string {
  if (typeof c.before !== 'number' || typeof c.after !== 'number' || !Number.isFinite(c.before) || !Number.isFinite(c.after)) return ''
  const d = c.after - c.before
  if (d === 0) return ''
  const pct = c.before !== 0 ? ` (${d > 0 ? '+' : '−'}${Math.round(Math.abs(d / c.before) * 100)}%)` : ''
  const abs = Math.abs(d)
  const n = Number.isInteger(abs) ? String(abs) : String(Number(abs.toPrecision(3)))
  return `${d > 0 ? '+' : '−'}${n}${c.unit ? ` ${c.unit}` : ''}${pct}`
}

function sideValue(v: ReactNode, unit?: string): ReactNode {
  if (typeof v === 'number') return `${v}${unit ? ` ${unit}` : ''}`
  return linkify(v)
}

function ChangeRow({ c, beforeLabel, afterLabel }: { c: ChangeProps; beforeLabel: string; afterLabel: string }): ReactElement {
  const result = changeResult(c)
  const delta = changeDelta(c)
  const bVideo = c.beforeVideo ?? c.video
  const aVideo = c.afterVideo ?? c.video
  const bLinked = c.beforeFrame != null || c.beforeT != null
  const aLinked = c.afterFrame != null || c.afterT != null
  const bTone = result === 'fixed' ? 'k-error' : result === 'worse' ? 'k-ok' : ''
  const aTone = result ? toneClass(RESULT_TONE[result]) : ''
  return (
    <div className="rk-ba-row" data-change={result ?? ''}>
      <div className="rk-ba-name">
        <span title={c.name}>{c.name}</span>
        {result && <Badge tone={RESULT_TONE[result]}>{RESULT_LABEL[result]}</Badge>}
      </div>
      <div className="rk-ba-pair">
        <div className={`rk-ba-side ${bTone}`}>
          <span className="rk-ba-tag">{beforeLabel}</span>
          <div className="rk-ba-val">{sideValue(c.before, c.unit)}</div>
          {bLinked && <FrameLink video={bVideo} frame={c.beforeFrame} t={c.beforeT} />}
        </div>
        <div className="rk-ba-arrow">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
          {delta && <span className={aTone}>{delta}</span>}
        </div>
        <div className={`rk-ba-side ${aTone}`}>
          <span className="rk-ba-tag">{afterLabel}</span>
          <div className="rk-ba-val">{sideValue(c.after, c.unit)}</div>
          {aLinked && <FrameLink video={aVideo} frame={c.afterFrame} t={c.afterT} />}
        </div>
      </div>
      {c.detail != null && <div className="rk-ba-detail">{linkify(c.detail)}</div>}
      {c.beforeImage && c.afterImage && (
        <Compare before={c.beforeImage} after={c.afterImage} beforeLabel={beforeLabel} afterLabel={afterLabel} />
      )}
    </div>
  )
}

export function Change(props: ChangeProps): ReactElement {
  return (
    <div className="rk-card">
      <ChangeRow c={props} beforeLabel="Before" afterLabel="After" />
    </div>
  )
}

export function BeforeAfter({
  title,
  beforeLabel = 'Before',
  afterLabel = 'After',
  children
}: {
  title?: ReactNode
  beforeLabel?: string
  afterLabel?: string
  children?: ReactNode
}): ReactElement {
  const nodes = flatten(children)
  const items = nodes.filter((n): n is ReactElement<ChangeProps> => isValidElement(n) && n.type === Change).map((n) => n.props)
  const rest = nodes.filter((n) => !(isValidElement(n) && n.type === Change))
  const count: Record<ChangeResult, number> = { fixed: 0, better: 0, same: 0, worse: 0 }
  for (const c of items) {
    const r = changeResult(c)
    if (r) count[r]++
  }
  const counted = RESULTS.filter((r) => count[r] > 0)
  return (
    <Card title={title}>
      {counted.length > 0 && (
        <div className="rk-checks-bar">
          <div className="rk-checks-sum">
            {counted.map((r) => (
              <span key={r}>
                <span className={`sr-dot ${toneClass(RESULT_TONE[r])}`} style={{ background: r === 'same' ? 'var(--ink-3)' : 'var(--k)' }} />
                {count[r]} {RESULT_LABEL[r].toLowerCase()}
              </span>
            ))}
          </div>
        </div>
      )}
      {items.length ? (
        items.map((c, i) => <ChangeRow key={i} c={c} beforeLabel={beforeLabel} afterLabel={afterLabel} />)
      ) : (
        <div className="rk-empty">No changes listed</div>
      )}
      {rest}
    </Card>
  )
}

export function Callout({ tone = 'info', title, children }: { tone?: Tone; title?: ReactNode; children?: ReactNode }): ReactElement {
  return (
    <div className={`rk-summary rk-callout ${toneClass(tone)}`}>
      {title != null && <div className="rk-callout-title">{title}</div>}
      <div>{linkify(children)}</div>
    </div>
  )
}

export function Videos({
  title,
  sync = true,
  min = 320,
  height,
  children
}: {
  title?: ReactNode
  sync?: boolean
  min?: number
  height?: number
  children?: ReactNode
}): ReactElement {
  const kids = flatten(children)
  const items = kids.filter((c): c is ReactElement<VideoProps> => isValidElement(c) && c.type === Video).map((c) => c.props)
  const value = useMemo(() => ({ height: Math.max(220, Number(height) || 380) }), [height])
  if (sync && items.length > 0 && items.length === kids.length) return <SyncedVideos title={title} height={height} items={items} />
  const m = Math.max(200, Number(min) || 320)
  return (
    <Card title={title}>
      <div className="rk-videos" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${m}px), 1fr))` }}>
        <VideoSyncContext.Provider value={value}>{children}</VideoSyncContext.Provider>
      </div>
    </Card>
  )
}

export function Values({
  title,
  values,
  min = 180
}: {
  title?: ReactNode
  values: Record<string, ReactNode> | [ReactNode, ReactNode][]
  min?: number
}): ReactElement {
  const list: [ReactNode, ReactNode][] = Array.isArray(values) ? values : Object.entries(values ?? {})
  const m = Math.max(100, Number(min) || 180)
  return (
    <Card title={title}>
      <dl className="rk-values" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${m}px), 1fr))` }}>
        {list.map(([k, v], i) => (
          <div key={i} className="rk-value">
            <dt>{k}</dt>
            <dd>{typeof v === 'number' || typeof v === 'boolean' ? String(v) : linkify(v)}</dd>
          </div>
        ))}
      </dl>
      {!list.length && <div className="rk-empty">No values</div>}
    </Card>
  )
}

interface StepProps {
  name: string
  status?: StepStatus
  call?: string
  detail?: ReactNode
  ms?: number
  video?: string
  frame?: number
  t?: number
  report?: string
  children?: ReactNode
}

export function Step(props: StepProps): ReactElement {
  return <Steps>{[<Step key="0" {...props} />]}</Steps>
}

const STEP_TONE: Record<StepStatus, string> = { pass: 'k-ok', fail: 'k-error', skip: '', info: 'k-info', wait: 'k-warn' }

export function Steps({ title, children }: { title?: ReactNode; children?: ReactNode }): ReactElement {
  const nodes = flatten(children)
  const items = nodes.filter((n): n is ReactElement<StepProps> => isValidElement(n) && n.type === Step).map((n) => n.props)
  const rest = nodes.filter((n) => !(isValidElement(n) && n.type === Step))
  return (
    <Card title={title}>
      <ol className="rk-steps">
        {items.map((st, i) => {
          const status = st.status ?? 'info'
          const linked = st.frame != null || st.t != null || !!st.report
          return (
            <li key={i} className={`rk-step ${STEP_TONE[status] ?? ''}`} data-step={status}>
              <span className="rk-step-dot">{status === 'pass' ? '✓' : status === 'fail' ? '✕' : i + 1}</span>
              <div className="rk-step-body">
                <div className="rk-step-hd">
                  <span className="rk-step-name">{linkify(st.name)}</span>
                  {st.call && <code className="rk-step-call">{st.call}</code>}
                  <span className="sr-spacer" />
                  {linked && <FrameLink video={st.video} frame={st.frame} t={st.t} report={st.report} />}
                  {st.ms != null && <span className="rk-check-ms">{msLabel(st.ms)}</span>}
                </div>
                {st.detail != null && <div className="rk-step-detail">{linkify(st.detail)}</div>}
                {st.children}
              </div>
            </li>
          )
        })}
      </ol>
      {!items.length && <div className="rk-empty">No steps</div>}
      {rest}
    </Card>
  )
}

const SERIES_COLORS = ['#3987e5', '#d95926', '#9085e9', '#c98500', '#d55181']

interface Pt {
  x: number
  v: number
}

function chartPoints(points: ChartPoint[] | number[], useFrame: boolean): Pt[] {
  const out: Pt[] = []
  ;(points ?? []).forEach((p, i) => {
    if (typeof p === 'number') out.push({ x: i, v: p })
    else if (p && Number.isFinite(p.v)) {
      const x = useFrame ? (p.frame ?? (p.t != null ? NaN : i)) : (p.t ?? NaN)
      if (Number.isFinite(x)) out.push({ x, v: p.v })
    }
  })
  return out.sort((a, b) => a.x - b.x)
}

function nearest(pts: Pt[], x: number): Pt | null {
  if (!pts.length) return null
  let lo = 0
  let hi = pts.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (pts[mid].x < x) lo = mid
    else hi = mid
  }
  return Math.abs(pts[lo].x - x) <= Math.abs(pts[hi].x - x) ? pts[lo] : pts[hi]
}

function niceTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  if (min === max) return [min]
  const raw = (max - min) / Math.max(1, count)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(Number(v.toPrecision(10)))
  return out
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return ''
  const a = Math.abs(v)
  if (a >= 1000 || Number.isInteger(v)) return String(Math.round(v * 100) / 100)
  return String(Number(v.toPrecision(3)))
}

export function Chart({
  title,
  series,
  unit,
  video,
  marks,
  threshold,
  yMin,
  yMax,
  height = 220
}: {
  title?: ReactNode
  series: ChartSeries[]
  unit?: string
  video?: string
  marks?: VideoEvent[]
  threshold?: { v: number; label?: string }
  yMin?: number
  yMax?: number
  height?: number
}): ReactElement {
  const api = useReport()
  const boxRef = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(600)
  const [hover, setHover] = useState<number | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  const list = (series ?? []).slice(0, SERIES_COLORS.length)
  const useFrame = list.some((s) => (s.points ?? []).some((p) => typeof p === 'number' || (p && p.frame != null)))
  const data = useMemo(() => list.map((s) => chartPoints(s.points, useFrame)), [series, useFrame])
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(Math.max(200, el.clientWidth)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (!video) return
    return api.subscribe(api.videoKey(video) ?? video, (f) => {
      if (useFrame) setCursor(f)
      else {
        const fps = api.fps(video)
        setCursor(fps ? f / fps : null)
      }
    })
  }, [api, video, useFrame])
  const all = data.flat()
  const h = Math.max(120, Number(height) || 220)
  const pad = { l: 44, r: 12, t: 10, b: 24 }
  const x0 = all.length ? Math.min(...all.map((p) => p.x)) : 0
  const x1 = all.length ? Math.max(...all.map((p) => p.x)) : 1
  let v0 = yMin ?? (all.length ? Math.min(...all.map((p) => p.v)) : 0)
  let v1 = yMax ?? (all.length ? Math.max(...all.map((p) => p.v)) : 1)
  if (threshold && Number.isFinite(threshold.v)) {
    if (yMin == null) v0 = Math.min(v0, threshold.v)
    if (yMax == null) v1 = Math.max(v1, threshold.v)
  }
  if (v0 === v1) {
    v0 -= 1
    v1 += 1
  }
  const yTicks = niceTicks(v0, v1, 4)
  if (yMin == null && yTicks.length) v0 = Math.min(v0, yTicks[0])
  if (yMax == null && yTicks.length) v1 = Math.max(v1, yTicks[yTicks.length - 1])
  const sx = (x: number): number => pad.l + ((x - x0) / (x1 - x0 || 1)) * (w - pad.l - pad.r)
  const sy = (v: number): number => pad.t + (1 - (v - v0) / (v1 - v0 || 1)) * (h - pad.t - pad.b)
  const ix = (px: number): number => x0 + ((px - pad.l) / (w - pad.l - pad.r || 1)) * (x1 - x0)
  const xTicks = niceTicks(x0, x1, Math.max(2, Math.floor(w / 110)))
  const xLabel = (x: number): string => (useFrame ? `F ${Math.round(x)}` : `${fmtNum(x)} s`)
  const at = hover != null ? hover : null
  const hits = at != null ? data.map((pts) => nearest(pts, at)) : []
  const snapX = hits.find(Boolean)?.x ?? at
  const go = (x: number): void => {
    if (!video && !api.hasVideo(undefined)) return
    api.goto(useFrame ? { video, frame: Math.round(x) } : { video, t: x }, 'Chart click')
  }
  return (
    <Card title={title}>
      {list.length > 1 && (
        <div className="rk-chart-legend">
          {list.map((s, i) => (
            <span key={i}>
              <i style={{ background: s.color ?? SERIES_COLORS[i] }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div ref={boxRef} className="rk-chart" style={{ height: h }}>
        <svg
          width={w}
          height={h}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            const px = ((e.clientX - r.left) / (r.width || 1)) * w
            setHover(px >= pad.l && px <= w - pad.r ? ix(px) : null)
          }}
          onPointerLeave={() => setHover(null)}
          onClick={() => snapX != null && go(snapX)}
          style={{ cursor: video || api.hasVideo(undefined) ? 'pointer' : 'crosshair' }}
        >
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line x1={pad.l} x2={w - pad.r} y1={sy(v)} y2={sy(v)} className="rk-chart-grid" />
              <text x={pad.l - 6} y={sy(v)} className="rk-chart-tick" textAnchor="end" dominantBaseline="middle">
                {fmtNum(v)}
              </text>
            </g>
          ))}
          {xTicks.map((x) => (
            <text key={`x${x}`} x={sx(x)} y={h - 6} className="rk-chart-tick" textAnchor="middle">
              {xLabel(x)}
            </text>
          ))}
          {threshold && Number.isFinite(threshold.v) && (
            <g>
              <line x1={pad.l} x2={w - pad.r} y1={sy(threshold.v)} y2={sy(threshold.v)} className="rk-chart-threshold" />
              {threshold.label && (
                <text x={w - pad.r} y={sy(threshold.v) - 4} className="rk-chart-tick" textAnchor="end">
                  {threshold.label}
                </text>
              )}
            </g>
          )}
          {(marks ?? []).map((m, i) => {
            const x = useFrame ? m.frame : m.t
            if (x == null || x < x0 || x > x1) return null
            return (
              <g key={`m${i}`}>
                <line x1={sx(x)} x2={sx(x)} y1={pad.t} y2={h - pad.b} className={`rk-chart-mark ${toneClass(m.kind)}`} />
                <title>{m.label}</title>
              </g>
            )
          })}
          {data.map((pts, i) => (
            <path
              key={i}
              d={pts.map((p, j) => `${j ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.v).toFixed(1)}`).join('')}
              fill="none"
              stroke={list[i].color ?? SERIES_COLORS[i]}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {cursor != null && cursor >= x0 && cursor <= x1 && (
            <line x1={sx(cursor)} x2={sx(cursor)} y1={pad.t} y2={h - pad.b} className="rk-chart-cursor" />
          )}
          {snapX != null && (
            <g pointerEvents="none">
              <line x1={sx(snapX)} x2={sx(snapX)} y1={pad.t} y2={h - pad.b} className="rk-chart-hover" />
              {hits.map((p, i) =>
                p ? <circle key={i} cx={sx(p.x)} cy={sy(p.v)} r={4} fill={list[i].color ?? SERIES_COLORS[i]} stroke="var(--panel)" strokeWidth={2} /> : null
              )}
            </g>
          )}
        </svg>
        {snapX != null && (
          <div className="rk-chart-tip" style={{ left: Math.min(sx(snapX) + 10, w - 170), top: pad.t }}>
            <div className="rk-chart-tip-x">{xLabel(snapX)}</div>
            {hits.map((p, i) =>
              p ? (
                <div key={i}>
                  <i style={{ background: list[i].color ?? SERIES_COLORS[i] }} />
                  {list.length > 1 && <span>{list[i].name}</span>}
                  <b>
                    {fmtNum(p.v)}
                    {unit ? ` ${unit}` : ''}
                  </b>
                </div>
              ) : null
            )}
          </div>
        )}
        {!all.length && <div className="rk-empty">No data points</div>}
      </div>
    </Card>
  )
}

const FILE_STATUS: Record<string, { letter: string; tone: string; label: string }> = {
  added: { letter: 'A', tone: 'k-ok', label: 'Added' },
  modified: { letter: 'M', tone: 'k-warn', label: 'Modified' },
  deleted: { letter: 'D', tone: 'k-error', label: 'Deleted' },
  renamed: { letter: 'R', tone: 'k-info', label: 'Renamed' }
}

function FileRow({ f }: { f: FileChange }): ReactElement {
  const [open, setOpen] = useState(false)
  const st = FILE_STATUS[f.status ?? 'modified'] ?? FILE_STATUS.modified
  const add = Math.max(0, Number(f.added) || 0)
  const del = Math.max(0, Number(f.removed) || 0)
  const total = add + del
  const blocks = total ? Math.max(1, Math.min(5, Math.round(total / 10) || 1)) : 0
  const green = total ? Math.round((add / total) * blocks) : 0
  const hasBody = !!f.diff || f.note != null
  return (
    <div className={`rk-check ${open && hasBody ? 'open' : ''}`}>
      <div className={`rk-check-hd rk-file-hd ${hasBody ? '' : 'static'}`} onClick={hasBody ? () => setOpen((o) => !o) : undefined}>
        {hasBody ? <Icon name="chev" /> : <span />}
        <span className={`rk-file-st ${st.tone}`} title={st.label}>
          {st.letter}
        </span>
        <span className="rk-file-path" onClick={(e) => e.stopPropagation()}>
          {f.from && <span className="rk-file-from">{f.from} → </span>}
          {f.status === 'deleted' ? <span>{f.path}</span> : <CodeRef path={f.path} />}
        </span>
        <span className="rk-file-diff">
          {add > 0 && <span className="k-ok">+{add}</span>}
          {del > 0 && <span className="k-error">−{del}</span>}
          {blocks > 0 && (
            <span className="rk-file-bar">
              {Array.from({ length: 5 }, (_, i) => (
                <i key={i} className={i < green ? 'k-ok' : i < blocks ? 'k-error' : ''} />
              ))}
            </span>
          )}
        </span>
      </div>
      {open && hasBody && (
        <div className="rk-check-bd">
          {f.note != null && <div className="rk-check-detail">{linkify(f.note)}</div>}
          {f.diff && <Code lang="diff">{f.diff}</Code>}
        </div>
      )}
    </div>
  )
}

export function Files({ title, files }: { title?: ReactNode; files: FileChange[] }): ReactElement {
  const list = files ?? []
  const add = list.reduce((n, f) => n + (Number(f.added) || 0), 0)
  const del = list.reduce((n, f) => n + (Number(f.removed) || 0), 0)
  return (
    <Card title={title}>
      <div className="rk-checks-bar">
        <div className="rk-checks-sum">
          <span>
            {list.length} file{list.length === 1 ? '' : 's'}
          </span>
          {add > 0 && <span className="k-ok" style={{ color: 'var(--k)' }}>+{add}</span>}
          {del > 0 && <span className="k-error" style={{ color: 'var(--k)' }}>−{del}</span>}
        </div>
      </div>
      {list.map((f, i) => (
        <FileRow key={`${f.path}:${i}`} f={f} />
      ))}
      {!list.length && <div className="rk-empty">No files changed</div>}
    </Card>
  )
}

function sameValue(a: ReactNode, b: ReactNode, tolerance: number): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tolerance
  if ((typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') && (typeof b === 'string' || typeof b === 'number' || typeof b === 'boolean'))
    return String(a) === String(b)
  return true
}

export function PlayerTable({ title, players, rows }: { title?: ReactNode; players: string[]; rows: PlayerRow[] }): ReactElement {
  const cols = players ?? []
  const list = rows ?? []
  const checked = list.map((r) => {
    if (r.expect === 'any') return { r, diff: [] as boolean[], ok: true, checked: false }
    const base = r.values?.[0]
    const diff = (r.values ?? []).map((v, i) => i > 0 && !sameValue(base, v, Math.max(0, Number(r.tolerance) || 0)))
    return { r, diff, ok: !diff.some(Boolean), checked: true }
  })
  const compared = checked.filter((c) => c.checked)
  const bad = compared.filter((c) => !c.ok).length
  return (
    <Card title={title}>
      {compared.length > 0 && (
        <div className="rk-checks-bar">
          <div className="rk-checks-sum">
            <span>
              <span className="sr-dot k-ok" style={{ background: 'var(--k)' }} />
              {compared.length - bad} match on every player
            </span>
            {bad > 0 && (
              <span>
                <span className="sr-dot k-error" style={{ background: 'var(--k)' }} />
                {bad} differ
              </span>
            )}
          </div>
        </div>
      )}
      <Activatable kind="scroll">
        <div className="rk-table-wrap">
          <table className="rk-table rk-players">
            <thead>
              <tr>
                <th />
                {cols.map((p, i) => (
                  <th key={i} style={{ textAlign: 'right' }}>
                    {p}
                    {i === 0 && cols.length > 1 && <small> (reference)</small>}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {checked.map(({ r, diff, ok, checked: c }, i) => (
                <tr key={i} className={c && !ok ? 'k-error rk-players-bad' : ''}>
                  <td className={`rk-players-name ${cellFit(nodeText(r.name))}`}>
                    {linkify(r.name)}
                    {r.tolerance ? <small> ±{r.tolerance}{r.unit ? ` ${r.unit}` : ''}</small> : null}
                  </td>
                  {cols.map((_, j) => {
                    const v = r.values?.[j]
                    return (
                      <td key={j} className={`rk-players-v ${cellFit(nodeText(v))} ${diff[j] ? 'k-error rk-players-diff' : ''}`}>
                        {v == null ? '—' : typeof v === 'number' ? `${fmtNum(v)}${r.unit ? ` ${r.unit}` : ''}` : typeof v === 'boolean' ? String(v) : linkify(v)}
                      </td>
                    )
                  })}
                  <td className="rk-players-st">{c ? <Icon name={ok ? 'pass' : 'fail'} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Activatable>
      {!list.length && <div className="rk-empty">No rows</div>}
    </Card>
  )
}

type ActionState = { kind: 'idle' } | { kind: 'confirm' } | { kind: 'running'; since: number } | { kind: 'done'; text: string } | { kind: 'error'; text: string }

function shortResult(raw: string | undefined): string {
  const text = String(raw ?? '').trim()
  if (!text || text === 'undefined' || text === 'null') return ''
  return text.length > 300 ? `${text.slice(0, 299)}…` : text
}

type ActionProps = {
  label: string
  run: string
  tone?: 'default' | 'primary' | 'danger'
  confirm?: string
  done?: string
  hint?: string
}

export function Action(props: ActionProps): ReactElement {
  const api = useReport()
  return api.bridge.action ? <LiveAction {...props} /> : <></>
}

function LiveAction({ label, run, tone = 'default', confirm, done, hint }: ActionProps): ReactElement {
  const api = useReport()
  const [state, setState] = useState<ActionState>({ kind: 'idle' })
  const [showCode, setShowCode] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const start = (): void => {
    setState({ kind: 'running', since: Date.now() })
    const action = api.bridge.action
    if (!action) return
    action(api.host.file, String(run ?? ''), api.host.root).then(
      (reply) => {
        if (!alive.current) return
        if (reply.ok) setState({ kind: 'done', text: done ?? (shortResult(reply.result) || 'Done') })
        else setState({ kind: 'error', text: reply.failure?.message ?? reply.error ?? 'The script failed' })
      },
      (e: unknown) => alive.current && setState({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    )
  }
  const busy = state.kind === 'running'
  return (
    <div className={`rk-action ${tone}`} data-report-action={label}>
      <div className="rk-action-row">
        {state.kind === 'confirm' ? (
          <>
            <span className="rk-action-ask">{confirm}</span>
            <button type="button" className={`rk-action-btn ${tone === 'danger' ? 'danger' : 'primary'}`} onClick={start}>
              {label}
            </button>
            <button type="button" className="rk-action-btn" onClick={() => setState({ kind: 'idle' })}>
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className={`rk-action-btn ${tone}`}
            disabled={busy}
            title={hint}
            onClick={() => (confirm ? setState({ kind: 'confirm' }) : start())}
          >
            {busy && <span className="rk-action-spin" />}
            {busy ? `${label}…` : label}
          </button>
        )}
        <button
          type="button"
          className={`rk-action-code ${showCode ? 'on' : ''}`}
          title={showCode ? 'Hide the script this button runs' : 'Show the script this button runs'}
          onClick={() => setShowCode((v) => !v)}
        >
          {'</>'}
        </button>
        {state.kind === 'done' && <span className="rk-action-out k-ok">{linkify(state.text)}</span>}
        {state.kind === 'error' && <span className="rk-action-out k-error">{state.text}</span>}
      </div>
      {hint && state.kind === 'idle' && <div className="rk-action-hint">{hint}</div>}
      {showCode && <Code lang="js">{String(run ?? '')}</Code>}
    </div>
  )
}

type DiffCell = ReactNode | null | undefined

const isEmptyCell = (v: DiffCell): boolean => v === null || v === undefined || v === '' || v === false

function cellText(v: DiffCell): string | null {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v)
  return null
}

function sameCell(a: DiffCell, b: DiffCell): boolean {
  if (isEmptyCell(a) && isEmptyCell(b)) return true
  const ta = cellText(a)
  const tb = cellText(b)
  if (ta !== null && tb !== null) return ta === tb
  return a === b
}

function CellValue({ v, empty }: { v: DiffCell; empty: string }): ReactElement {
  if (isEmptyCell(v)) return <span className="rk-dt-empty">{empty}</span>
  return <>{typeof v === 'number' ? fmtNum(v) : linkify(v)}</>
}

export function DiffTable({
  title,
  columns,
  rows,
  rowLabel,
  beforeLabel = 'Before',
  afterLabel = 'After',
  empty = '—'
}: {
  title?: ReactNode
  columns: string[]
  rows: DiffRow[]
  rowLabel?: string
  beforeLabel?: string
  afterLabel?: string
  empty?: string
}): ReactElement {
  const api = useReport()
  const cols = columns ?? []
  const list = (rows ?? []).map((r) => {
    const after = (r.after ?? r.values ?? []) as DiffCell[]
    const before = (r.before ?? r.values ?? r.after ?? []) as DiffCell[]
    const changed = cols.map((_, i) => !sameCell(before[i], after[i]))
    return { r, before, after, changed, n: changed.filter(Boolean).length }
  })
  const rowsChanged = list.filter((x) => x.n > 0).length
  const cellsChanged = list.reduce((n, x) => n + x.n, 0)
  const id = `difftable:${typeof title === 'string' ? title : ''}:${cols.join('|')}`
  const [only, setOnly] = api.usePersisted<boolean>(`${id}.only`, () => false)
  const shown = only ? list.filter((x) => x.n > 0) : list
  return (
    <Card title={title}>
      <div className="rk-checks-bar">
        <div className="rk-checks-sum">
          <span>
            <span className="sr-dot k-warn" style={{ background: 'var(--k)' }} />
            {cellsChanged} change{cellsChanged === 1 ? '' : 's'} in {rowsChanged} of {list.length} row{list.length === 1 ? '' : 's'}
          </span>
          <span className="rk-dt-legend">
            <s>{beforeLabel}</s>
            <span>→</span>
            <b>{afterLabel}</b>
          </span>
        </div>
        <span className="sr-spacer" />
        <div className="sr-seg">
          <button type="button" className={`sr-btn ${!only ? 'on' : ''}`} onClick={() => setOnly(false)}>
            All rows
          </button>
          <button type="button" className={`sr-btn ${only ? 'on' : ''}`} onClick={() => setOnly(true)}>
            Changed
          </button>
        </div>
      </div>
      <Activatable kind="scroll">
        <div className="rk-table-wrap">
          <table className="rk-table rk-dt">
            <thead>
              <tr>
                <th>{rowLabel ?? ''}</th>
                {cols.map((c, i) => (
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map(({ r, before, after, changed, n }, i) => (
                <tr key={i} className={n ? 'rk-dt-changed' : ''}>
                  <td className={`rk-dt-name ${cellFit(nodeText(r.name))}`}>
                    <span>{linkify(r.name)}</span>
                    {r.note != null && <small>{linkify(r.note)}</small>}
                  </td>
                  {cols.map((_, j) => {
                    if (!changed[j])
                      return (
                        <td key={j} className={`rk-dt-same ${cellFit(nodeText(after[j]))}`}>
                          <CellValue v={after[j]} empty={empty} />
                        </td>
                      )
                    const kind = isEmptyCell(before[j]) ? 'added' : isEmptyCell(after[j]) ? 'removed' : 'changed'
                    return (
                      <td key={j} className={`rk-dt-cell ${kind} ${cellFit(nodeText(before[j]), nodeText(after[j]))}`} data-diff={kind}>
                        <div className="rk-dt-old" title={beforeLabel}>
                          <CellValue v={before[j]} empty={empty} />
                        </div>
                        <div className="rk-dt-new" title={afterLabel}>
                          <CellValue v={after[j]} empty={empty} />
                        </div>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Activatable>
      {!shown.length && <div className="rk-empty">{list.length ? 'Nothing changed' : 'No rows'}</div>}
    </Card>
  )
}

function gitStatus(s: Status): 'added' | 'deleted' | 'renamed' | 'modified' {
  if ([Status.INDEX_ADDED, Status.UNTRACKED, Status.INTENT_TO_ADD, Status.ADDED_BY_US, Status.ADDED_BY_THEM, Status.BOTH_ADDED].includes(s)) return 'added'
  if ([Status.INDEX_DELETED, Status.DELETED, Status.DELETED_BY_US, Status.DELETED_BY_THEM, Status.BOTH_DELETED].includes(s)) return 'deleted'
  if ([Status.INDEX_RENAMED, Status.INTENT_TO_RENAME, Status.INDEX_COPIED].includes(s)) return 'renamed'
  return 'modified'
}

interface GitFile {
  path: string
  oldPath?: string
  status: 'added' | 'deleted' | 'renamed' | 'modified'
  added?: number
  removed?: number
}

interface GitDiffData {
  root: string
  ref1: string
  ref2: string
  files: GitFile[]
  commit?: Commit
  label: string
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const shortRef = (r: string): string => (/^[0-9a-f]{12,40}$/i.test(r) ? r.slice(0, 8) : r)

async function loadGitDiff(scm: ReportGit, projectRoot: string, opts: { commit?: string; from?: string; to?: string; paths?: string[] }): Promise<GitDiffData> {
  const state = await scm.getState(projectRoot)
  if (!state.ok) throw new Error(state.error.message ?? 'This project is not in a Git repository')
  const root = state.value.root
  const sub = projectRoot.replace(/\\/g, '/').startsWith(`${root.replace(/\\/g, '/')}/`) ? projectRoot.replace(/\\/g, '/').slice(root.length + 1) : ''
  let ref1 = 'HEAD'
  let ref2 = WORKTREE_REF
  let label = 'Uncommitted changes'
  let commit: Commit | undefined
  let changes: (Change & { insertions?: number; deletions?: number })[] = []
  if (opts.commit || opts.from || opts.to) {
    if (opts.commit) {
      const c = await scm.getCommit(root, opts.commit)
      if (!c.ok) throw new Error(`No commit ${opts.commit}: ${c.error.message ?? ''}`)
      commit = c.value
      ref2 = c.value.hash
      ref1 = c.value.parents[0] ?? EMPTY_TREE
      label = `${shortRef(ref2)} ${c.value.message.split('\n')[0]}`
    } else {
      ref1 = opts.from ?? 'HEAD'
      ref2 = opts.to ?? 'HEAD'
      label = `${shortRef(ref1)}..${shortRef(ref2)}`
    }
    const d = await scm.diffBetweenWithStats(root, ref1 === EMPTY_TREE ? undefined : ref1, ref2)
    if (!d.ok) throw new Error(d.error.message ?? 'git diff failed')
    changes = d.value
  } else {
    const seen = new Set<string>()
    for (const c of [...state.value.indexChanges, ...state.value.workingTreeChanges]) {
      if (seen.has(c.path)) continue
      seen.add(c.path)
      changes.push(c)
    }
  }
  const want = (opts.paths ?? []).map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')).filter(Boolean)
  const match = (p: string): boolean =>
    !want.length || want.some((w) => [w, sub ? `${sub}/${w}` : w].some((x) => p === x || p.startsWith(`${x}/`)))
  const files = changes
    .filter((c) => match(c.path) || match(c.originalPath))
    .map((c) => ({
      path: c.path,
      oldPath: c.originalPath && c.originalPath !== c.path ? c.originalPath : undefined,
      status: gitStatus(c.status),
      added: c.insertions,
      removed: c.deletions
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
  return { root, ref1, ref2, files, commit, label }
}

function GitFileRow({ f, data, open, onToggle, sideBySide }: { f: GitFile; data: GitDiffData; open: boolean; onToggle: () => void; sideBySide: boolean }): ReactElement {
  const st = FILE_STATUS[f.status]
  const add = f.added ?? 0
  const del = f.removed ?? 0
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : ''
  const base = f.path.slice(dir.length)
  return (
    <div className={`rk-check ${open ? 'open' : ''}`} data-git-file={f.path}>
      <div className="rk-check-hd rk-file-hd" onClick={onToggle}>
        <Icon name="chev" />
        <span className={`rk-file-st ${st.tone}`} title={st.label}>
          {st.letter}
        </span>
        <span className="rk-file-path" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
          <span className="rk-gd-base">{base}</span>
          <span className="rk-file-from"> {f.oldPath ? `${f.oldPath} → ${dir}` : dir}</span>
        </span>
        <span className="rk-file-diff">
          {add > 0 && <span className="k-ok">+{add}</span>}
          {del > 0 && <span className="k-error">−{del}</span>}
        </span>
      </div>
      {open && (
        <div className="rk-gd-body">
          <Activatable kind="scroll">
            <Suspense fallback={<div className="rk-gd-loading">Loading diff…</div>}>
              <FileDiff root={data.root} path={f.path} oldPath={f.oldPath} ref1={data.ref1} ref2={data.ref2} sideBySide={sideBySide} />
            </Suspense>
          </Activatable>
        </div>
      )}
    </div>
  )
}

export function GitDiff({
  commit,
  from,
  to,
  paths,
  title,
  open = 3,
  sideBySide
}: {
  commit?: string
  from?: string
  to?: string
  paths?: string[]
  title?: ReactNode
  open?: number
  sideBySide?: boolean
}): ReactElement {
  const api = useReport()
  const [data, setData] = useState<GitDiffData | null>(null)
  const [error, setError] = useState('')
  const key = JSON.stringify([commit, from, to, paths])
  const id = `gitdiff:${key}`
  const [split, setSplit] = api.usePersisted<boolean>(`${id}.split`, () => sideBySide === true)
  const [toggled, setToggled] = api.usePersisted<string[]>(`${id}.open`, () => [])
  useEffect(() => {
    let alive = true
    const done = api.host.store.begin()
    setError('')
    const bridge = api.bridge
    loadGitDiff(bridge.git, api.host.root, { commit, from, to, paths })
      .then(async (d) => {
        if (bridge.recording) await Promise.all(d.files.map((f) => bridge.git.patch(d.root, f.path, f.oldPath ?? f.path, d.ref1, d.ref2).catch(() => null)))
        if (alive) setData(d)
      })
      .catch((e: unknown) => {
        if (!alive) return
        const text = e instanceof Error ? e.message : String(e)
        setError(text)
        api.host.store.warn(`GitDiff: ${text}`)
      })
      .finally(done)
    return () => {
      alive = false
      done()
    }
  }, [api, key])
  const files = data?.files ?? []
  const isOpen = (i: number, p: string): boolean => (i < Math.max(0, Number(open) || 0)) !== toggled.includes(p)
  const add = files.reduce((n, f) => n + (f.added ?? 0), 0)
  const del = files.reduce((n, f) => n + (f.removed ?? 0), 0)
  const c = data?.commit
  const [full, setFull] = useState(false)
  const seg = (
    <div className="sr-seg">
      <button type="button" className={`sr-btn ${!split ? 'on' : ''}`} onClick={() => setSplit(false)}>
        Inline
      </button>
      <button type="button" className={`sr-btn ${split ? 'on' : ''}`} onClick={() => setSplit(true)}>
        Side by side
      </button>
    </div>
  )
  const rows =
    data &&
    files.map((f, i) => (
      <GitFileRow
        key={f.path}
        f={f}
        data={data}
        sideBySide={split}
        open={isOpen(i, f.path)}
        onToggle={() => setToggled((prev) => (prev.includes(f.path) ? prev.filter((p) => p !== f.path) : [...prev, f.path]))}
      />
    ))
  return (
    <Card title={title ?? (data ? data.label : undefined)}>
      {c && (
        <div className="rk-gd-commit">
          <code>{c.hash.slice(0, 8)}</code>
          <span className="rk-gd-msg">{c.message.split('\n')[0]}</span>
          <span className="rk-gd-meta">
            {c.authorName}
            {c.authorDate ? ` · ${new Date(c.authorDate).toLocaleString()}` : ''}
          </span>
        </div>
      )}
      <div className="rk-checks-bar">
        <div className="rk-checks-sum">
          <span>
            {data ? `${files.length} file${files.length === 1 ? '' : 's'}` : error ? '' : 'Loading…'}
          </span>
          {add > 0 && <span className="k-ok" style={{ color: 'var(--k)' }}>+{add}</span>}
          {del > 0 && <span className="k-error" style={{ color: 'var(--k)' }}>−{del}</span>}
        </div>
        <span className="sr-spacer" />
        {seg}
        {data && files.length > 0 && <ExpandButton onClick={() => setFull(true)} />}
      </div>
      {error && <div className="rk-missing">{error}</div>}
      {!full && rows}
      {full && <div className="rk-fs-away rk-fs-away-sm">Showing in full screen</div>}
      {data && !files.length && <div className="rk-empty">No changes</div>}
      {full && (
        <Fullscreen kind="diff" title={title ?? data?.label ?? 'Changes'} tools={seg} onClose={() => setFull(false)}>
          <div className="rk-ov-scroll rk-gd-full">{rows}</div>
        </Fullscreen>
      )}
    </Card>
  )
}

const SWIPE_PX = 60

function usePhoneExpandOpen(el: HTMLElement | null, open: () => void): void {
  const ref = useRef(open)
  ref.current = open
  useEffect(() => {
    if (!el) return
    const on = (): void => ref.current()
    el.addEventListener('phone-expand-open', on)
    return () => el.removeEventListener('phone-expand-open', on)
  }, [el])
}

function shownSize(img: HTMLImageElement | null | undefined, info?: MediaInfo | null): { w: number; h: number } | undefined {
  if (img?.complete && img.naturalWidth > 0 && img.naturalHeight > 0) return { w: img.naturalWidth, h: img.naturalHeight }
  return info && info.width > 0 && info.height > 0 ? { w: info.width, h: info.height } : undefined
}

export function Carousel({
  images,
  title,
  height,
  start = 0
}: {
  images: (string | CarouselSlide)[]
  title?: ReactNode
  height?: number
  start?: number
}): ReactElement {
  const api = useReport()
  const slides = useMemo(() => (images ?? []).map((s) => (typeof s === 'string' ? { src: s } : s)).filter((s) => !!s?.src), [images])
  const id = `carousel:${slides.map((s) => s.src).join('|')}`
  const [index, setIndex] = api.usePersisted<number>(`${id}.at`, () => Math.max(0, Math.min(slides.length - 1, Number(start) || 0)))
  const missing = useMediaCheck(api, slides.map((s) => s.src))
  const swipe = useRef({ dx: 0, t: 0 })
  const stripRef = useRef<HTMLDivElement>(null)
  const n = slides.length
  const at = n ? Math.max(0, Math.min(n - 1, index)) : 0
  const go = (i: number): void => {
    if (!n) return
    setIndex(((i % n) + n) % n)
  }
  useEffect(() => {
    const strip = stripRef.current
    const thumb = strip?.querySelector<HTMLElement>(`[data-slide="${at}"]`)
    if (!strip || !thumb) return
    const s = strip.getBoundingClientRect()
    const t = thumb.getBoundingClientRect()
    const unit = strip.clientWidth > 0 ? s.width / strip.clientWidth : 1
    const pad = parseFloat(getComputedStyle(strip).paddingLeft) || 0
    if (t.left < s.left + pad * unit) strip.scrollLeft -= (s.left + pad * unit - t.left) / unit
    else if (t.right > s.right - pad * unit) strip.scrollLeft += (t.right - s.right + pad * unit) / unit
  }, [at])
  const cur = slides[at]
  const key = cur ? api.path(cur.src) : ''
  const [, setMeasured] = useState(0)
  const meta = useMediaInfo(api, missing ? [] : slides.map((s) => s.src))
  const aspect = key ? imageAspect(key) : undefined
  const h = Math.max(160, Number(height) || 460)
  const wait = useMediaGate(api, missing ? [] : slides.map((s) => s.src), { width: '100%', height: '100%', borderRadius: 0 })
  const phone = onPhone(api)
  const [stage, setStage] = useState<HTMLDivElement | null>(null)
  const [shown, setShown] = useState<HTMLImageElement | null>(null)
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  useMediaZoom(stage, shown, '.rk-carousel-nav, .rk-carousel-count')
  const nameOf = (s: CarouselSlide): string => s.alt || s.label || (typeof s.caption === 'string' ? s.caption : '') || s.src.split('/').pop() || s.src
  const openAt = (img?: HTMLImageElement | null): void => {
    if (!cur) return
    const size = shownSize(img ?? shown, meta.infos[at])
    api.host.showImage(
      api.url(cur.src),
      nameOf(cur),
      { items: slides.map((s, i) => ({ url: api.url(s.src), alt: nameOf(s), path: api.path(s.src), size: i === at ? size : shownSize(null, meta.infos[i]) })), index: at, onIndex: go },
      { path: key, size }
    )
  }
  usePhoneExpandOpen(phone ? box : null, () => openAt())
  return (
    <Card title={title}>
      {missing ? (
        <div className="rk-missing">{missing}</div>
      ) : !n ? (
        <div className="rk-empty">No images</div>
      ) : meta.error ? (
        <MediaWait style={{ height: h }} label="" error={meta.error} onRetry={meta.retry} />
      ) : (
        <Activatable kind="control">
          <div
            ref={setBox}
            className="rk-carousel"
            tabIndex={0}
            data-carousel={at}
            data-phone-expand-open={phone ? 'photo' : undefined}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') {
                e.preventDefault()
                go(at + 1)
              } else if (e.key === 'ArrowLeft') {
                e.preventDefault()
                go(at - 1)
              }
            }}
            onWheel={(e) => {
              if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
              const now = performance.now()
              const s = swipe.current
              if (now - s.t > 400) s.dx = 0
              s.t = now
              s.dx += e.deltaX
              if (Math.abs(s.dx) >= SWIPE_PX) {
                go(at + (s.dx > 0 ? 1 : -1))
                s.dx = 0
                s.t = now + 250
              }
            }}
          >
            <div ref={phone ? setStage : undefined} className="rk-carousel-stage" style={{ maxHeight: h, ...(aspect ? { aspectRatio: String(aspect) } : { height: h }) }}>
              {wait ?? <img
                key={cur.src}
                ref={phone ? setShown : undefined}
                src={api.url(cur.src)}
                alt={cur.alt ?? cur.label ?? (typeof cur.caption === 'string' ? cur.caption : '')}
                draggable={false}
                title="Click to enlarge"
                data-report-image={cur.src}
                onLoad={(e) => {
                  const had = imageAspect(key)
                  noteImageAspect(key, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)
                  if (imageAspect(key) !== had) setMeasured((n) => n + 1)
                }}
                onClick={(e) => openAt(e.currentTarget)}
              />}
              {n > 1 && (
                <>
                  <button type="button" className="rk-carousel-nav prev" aria-label="Previous image" onClick={() => go(at - 1)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
                  </button>
                  <button type="button" className="rk-carousel-nav next" aria-label="Next image" onClick={() => go(at + 1)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                  </button>
                  <span className="rk-carousel-count">
                    {at + 1} / {n}
                  </span>
                </>
              )}
            </div>
            {(cur.caption != null || cur.label) && (
              <div className="rk-carousel-cap">
                {cur.label && <b>{cur.label}</b>}
                {cur.caption != null && <span>{linkify(cur.caption)}</span>}
              </div>
            )}
            <div className="rk-media-acts">
              <SaveMedia key={key} ask={{ path: key, name: cur.src.split('/').pop() || cur.src, kind: 'image' }} />
            </div>
            {n > 1 && (
              <div className="rk-carousel-strip" ref={stripRef}>
                {slides.map((s, i) => (
                  <button
                    key={`${s.src}:${i}`}
                    type="button"
                    data-slide={i}
                    className={`rk-carousel-thumb ${i === at ? 'on' : ''}`}
                    title={s.label ?? (typeof s.caption === 'string' ? s.caption : s.src)}
                    onClick={() => go(i)}
                  >
                    {!wait && <img src={api.url(s.src)} alt="" draggable={false} loading="lazy" />}
                    {s.label && <span>{s.label}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </Activatable>
      )}
    </Card>
  )
}

function imageBox(info: MediaInfo | null | undefined, maxH?: number): CSSProperties {
  if (!info) return { height: maxH ? Math.min(maxH, 320) : 240 }
  const w = maxH ? Math.min(info.width, (maxH * info.width) / info.height) : info.width
  return { width: `min(100%, ${w}px)`, aspectRatio: `${info.width} / ${info.height}`, margin: '0 auto', padding: 0, minHeight: 0, overflow: 'hidden' }
}

export function Image({ src, alt, caption, height }: { src: string; alt?: string; caption?: ReactNode; height?: number }): ReactElement {
  const api = useReport()
  const missing = useMediaCheck(api, [src])
  const key = api.path(src)
  const meta = useMediaInfo(api, missing ? [] : [src])
  const info = meta.infos[0]
  const aspect = imageAspect(key)
  const wait = useMediaGate(api, missing ? [] : [src], imageBox(info, Number(height) || undefined))
  const phone = onPhone(api)
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [figure, setFigure] = useState<HTMLElement | null>(null)
  useMediaZoom(box, img)
  const open = (shown?: HTMLImageElement | null): void =>
    api.host.showImage(api.url(src), alt || src.split('/').pop() || src, undefined, { path: key, size: shownSize(shown ?? img, info) })
  usePhoneExpandOpen(phone ? figure : null, () => open())
  const picture = (
    <img
      ref={phone ? setImg : undefined}
      src={api.url(src)}
      alt={alt ?? ''}
      draggable={false}
      loading={api.host.scroller ? undefined : 'lazy'}
      decoding="async"
      width={info?.width}
      height={info?.height}
      style={{ ...(aspect && !info ? { aspectRatio: String(aspect) } : {}), ...(height ? { maxHeight: height, objectFit: 'contain' as const } : {}) }}
      title="Click to enlarge"
      data-report-image={src}
      onLoad={(e) => noteImageAspect(key, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
      onClick={(e) => open(e.currentTarget)}
    />
  )
  return (
    <figure ref={setFigure} className="rk-card rk-figure" data-phone-expand-open={phone ? 'photo' : undefined}>
      {missing ? (
        <div className="rk-missing">{missing}</div>
      ) : meta.error ? (
        <MediaWait style={imageBox(null, Number(height) || undefined)} label="" error={meta.error} onRetry={meta.retry} />
      ) : (
        wait ?? (phone ? (
          <div ref={setBox} className="rk-zoom">
            {picture}
          </div>
        ) : picture)
      )}
      {caption != null && (
        <figcaption>
          <span>{linkify(caption)}</span>
        </figcaption>
      )}
      {!missing && !meta.error && (
        <div className="rk-media-acts">
          <SaveMedia ask={{ path: key, name: src.split('/').pop() || src, kind: 'image' }} />
        </div>
      )}
    </figure>
  )
}

export const kit = {
  Report,
  Summary,
  Section,
  Grid,
  Row,
  Stat,
  Text,
  Badge,
  Markdown,
  Code,
  Table,
  Checks,
  Check,
  Video,
  Log,
  Compare,
  BeforeAfter,
  Change,
  Callout,
  Spoiler,
  Videos,
  Values,
  Steps,
  Step,
  Chart,
  Files,
  PlayerTable,
  DiffTable,
  GitDiff,
  Carousel,
  Action,
  Image,
  Popover,
  FrameLink,
  CodeRef
} satisfies typeof Kit
