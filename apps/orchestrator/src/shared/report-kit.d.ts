import type { CSSProperties, ReactElement, ReactNode } from 'react'

export type Tone = 'ok' | 'info' | 'warn' | 'error' | 'muted'
export type CheckStatus = 'pass' | 'fail' | 'skip'
export type ReportStatus = 'pass' | 'fail' | 'partial' | 'info'
export type ChangeResult = 'fixed' | 'better' | 'same' | 'worse'
export type StepStatus = 'pass' | 'fail' | 'skip' | 'info' | 'wait'

export interface ChartPoint {
  v: number
  frame?: number
  t?: number
}

export interface ChartSeries {
  name: string
  points: ChartPoint[] | number[]
  color?: string
}

export interface FileChange {
  path: string
  status?: 'added' | 'modified' | 'deleted' | 'renamed'
  from?: string
  added?: number
  removed?: number
  diff?: string
  note?: ReactNode
}

export interface CarouselSlide {
  src: string
  caption?: ReactNode
  label?: string
  alt?: string
}

export interface DiffRow {
  name: ReactNode
  before?: ReactNode[]
  after?: ReactNode[]
  values?: ReactNode[]
  note?: ReactNode
}

export interface PlayerRow {
  name: string
  values: ReactNode[]
  unit?: string
  tolerance?: number
  expect?: 'same' | 'any'
}

export interface VideoEvent {
  label: string
  frame?: number
  t?: number
  kind?: 'ok' | 'info' | 'warn' | 'error'
}

export interface LogLine {
  msg: string
  level?: 'info' | 'warn' | 'error'
  frame?: number
  t?: number
  src?: string
  stack?: string
}

export interface TableColumn {
  key: string
  label?: string
  align?: 'left' | 'right' | 'center'
}

export function Report(props: {
  title: string
  subtitle?: ReactNode
  status?: ReportStatus
  meta?: ReactNode
  session?: string
  children?: ReactNode
}): ReactElement

export function Summary(props: { tone?: Tone; children?: ReactNode }): ReactElement

export function Section(props: {
  title?: ReactNode
  description?: ReactNode
  children?: ReactNode
  style?: CSSProperties
}): ReactElement

export function Grid(props: { min?: number; gap?: number; children?: ReactNode; style?: CSSProperties }): ReactElement

export function Row(props: {
  gap?: number
  align?: 'start' | 'center' | 'end' | 'baseline'
  justify?: 'start' | 'center' | 'end' | 'between'
  children?: ReactNode
  style?: CSSProperties
}): ReactElement

export function Stat(props: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: Tone; info?: ReactNode }): ReactElement

export function Text(props: { children?: ReactNode; tone?: Tone; size?: 'sm' | 'md'; mono?: boolean }): ReactElement

export function Badge(props: { tone?: Tone; children?: ReactNode; info?: ReactNode }): ReactElement

export function Popover(props: {
  children: ReactNode
  content?: ReactNode
  title?: ReactNode
  rows?: Record<string, ReactNode> | [ReactNode, ReactNode][]
  copy?: string
  placement?: 'top' | 'bottom' | 'left' | 'right'
}): ReactElement

export function Markdown(props: { children: string }): ReactElement

export function Code(props: { children: string; lang?: string; title?: string }): ReactElement

export function Table(props: {
  columns: (string | TableColumn)[]
  rows: (Record<string, ReactNode> | ReactNode[])[]
  title?: ReactNode
}): ReactElement

export function Checks(props: { title?: ReactNode; children?: ReactNode }): ReactElement

export function Check(props: {
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
}): ReactElement

export function Video(props: {
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
}): ReactElement

export function Videos(props: { title?: ReactNode; sync?: boolean; min?: number; height?: number; children?: ReactNode }): ReactElement

export function Values(props: { title?: ReactNode; values: Record<string, ReactNode> | [ReactNode, ReactNode][]; min?: number }): ReactElement

export function Steps(props: { title?: ReactNode; children?: ReactNode }): ReactElement

export function Step(props: {
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
}): ReactElement

export function Chart(props: {
  title?: ReactNode
  series: ChartSeries[]
  unit?: string
  video?: string
  marks?: VideoEvent[]
  threshold?: { v: number; label?: string }
  yMin?: number
  yMax?: number
  height?: number
}): ReactElement

export function Files(props: { title?: ReactNode; files: FileChange[] }): ReactElement

export function PlayerTable(props: { title?: ReactNode; players: string[]; rows: PlayerRow[] }): ReactElement

export function Log(props: {
  lines: LogLine[] | string
  title?: ReactNode
  video?: string
  height?: number
}): ReactElement

export function Compare(props: {
  before: string
  after: string
  beforeLabel?: string
  afterLabel?: string
  mode?: 'wipe' | 'side' | 'flip' | 'diff'
  title?: ReactNode
  height?: number
}): ReactElement

export function BeforeAfter(props: {
  title?: ReactNode
  beforeLabel?: string
  afterLabel?: string
  children?: ReactNode
}): ReactElement

export function Change(props: {
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
}): ReactElement

export function Callout(props: { tone?: Tone; title?: ReactNode; children?: ReactNode }): ReactElement

export function Spoiler(props: { title: ReactNode; open?: boolean; children?: ReactNode }): ReactElement

export function DiffTable(props: {
  title?: ReactNode
  columns: string[]
  rows: DiffRow[]
  rowLabel?: string
  beforeLabel?: string
  afterLabel?: string
  empty?: string
}): ReactElement

export function GitDiff(props: {
  commit?: string
  from?: string
  to?: string
  paths?: string[]
  title?: ReactNode
  open?: number
  sideBySide?: boolean
}): ReactElement

export function Carousel(props: { images: (string | CarouselSlide)[]; title?: ReactNode; height?: number; start?: number }): ReactElement

export function Action(props: {
  label: string
  run: string
  tone?: 'default' | 'primary' | 'danger'
  confirm?: string
  done?: string
  hint?: string
}): ReactElement

export function Image(props: { src: string; alt?: string; caption?: ReactNode; height?: number }): ReactElement

export function FrameLink(props: {
  video?: string
  frame?: number
  t?: number
  report?: string
  children?: ReactNode
}): ReactElement

export function CodeRef(props: { path: string; line?: number; endLine?: number; children?: ReactNode }): ReactElement
