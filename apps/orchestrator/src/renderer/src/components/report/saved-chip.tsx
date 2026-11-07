import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Clock } from 'lucide-react'
import { formatSize } from '@shared/file-picker'
import { plural, relativeTo, shortenPath, tildePath, type ReportHoverInfo } from '@shared/hover-info'
import { formatWhen, formatWhenFull } from '../../lib/when'
import { relativeTimeLong } from '../../lib/relative-time'
import { CardFooter, CardHeader, CardRow, CardRows, CopyAction, HoverCard } from '../ui/HoverCard'
import { AgentLine, usePtyAgent } from '../workbench/agent-line'

const FRESH_MS = 10 * 60_000

export interface SavedChipSource {
  file: string
  root: string
  load?: () => Promise<ReportHoverInfo | null>
}

function ReportTimeCard({ ms, source }: { ms: number; source?: SavedChipSource }): ReactElement {
  const [info, setInfo] = useState<ReportHoverInfo | null>(null)
  const load = useRef(source?.load)
  load.current = source?.load
  useEffect(() => {
    let alive = true
    load.current?.().then(
      (i) => alive && setInfo(i),
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [source?.file, source?.root])
  const agent = usePtyAgent(info?.owner ?? null)
  const file = source?.file ?? ''
  const shown = file ? relativeTo(file, source?.root ?? '') ?? tildePath(file, info?.home ?? '') : ''
  return (
    <div className="w-[320px] max-w-full" data-report-time-card>
      <CardHeader icon={<Clock size={13} strokeWidth={1.75} />} title={formatWhenFull(ms)} sub={relativeTimeLong(ms).replace(/^./, (c) => c.toUpperCase())} />
      {(file || info) && (
        <CardRows>
          {file && (
            <CardRow label="File" mono nowrap full={file}>
              {shortenPath(shown, 40)}
            </CardRow>
          )}
          {info?.bytes != null && <CardRow label="Size">{formatSize(info.bytes)}</CardRow>}
          {agent && (
            <CardRow label="Opened by">
              <AgentLine agent={agent} />
            </CardRow>
          )}
          {!!info?.links && <CardRow label="Links to">{plural(info.links, 'report')}</CardRow>}
          {!!info?.nested && <CardRow label="Nested">{plural(info.nested, 'report')}</CardRow>}
        </CardRows>
      )}
      {file && (
        <CardFooter>
          <CopyAction text={file} />
        </CardFooter>
      )}
    </div>
  )
}

export function SavedChip({
  ms,
  text,
  className = '',
  source
}: {
  ms: number
  text?: string
  className?: string
  source?: SavedChipSource
}): ReactElement {
  const [now, setNow] = useState(() => Date.now())
  const age = now - ms
  const fresh = age >= -60_000 && age < FRESH_MS
  useEffect(() => {
    if (!fresh) return
    const t = window.setTimeout(() => setNow(Date.now()), Math.max(1000, FRESH_MS - age + 500))
    return () => window.clearTimeout(t)
  }, [fresh, age])
  return (
    <HoverCard
      className={`rk-when ${fresh ? 'fresh' : ''} ${className}`}
      attrs={{ 'data-report-when': fresh ? 'fresh' : '' }}
      content={() => <ReportTimeCard ms={ms} source={source} />}
      label="Report saved"
    >
      <time dateTime={new Date(ms).toISOString()} className="contents">
        <Clock aria-hidden />
        {text ?? formatWhen(ms)}
      </time>
    </HoverCard>
  )
}
