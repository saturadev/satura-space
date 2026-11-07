import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { DiskBar, DiskSummary, LoadChart, Sparkline, cpuTicks, formatDisk, formatMem, formatPct, memTicks, stats, type SystemLoadState } from '../../components/system-load/SystemLoadCharts'
import { useShell } from './bridge'
import { useView } from './viewport'

function problem(load: SystemLoadState, online: boolean): string | null {
  if (!online) return load.loaded ? 'Your desktop is offline. These are the last numbers it sent.' : null
  if (!load.error) return null
  return `Can't read the desktop's load right now. ${load.error}`
}

function Cell({ label, value, children }: { label: string; value: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-[12px] text-[var(--ws-label2)]">{label}</span>
      <span className="truncate text-[15px] font-semibold">{value}</span>
      <div className="flex h-[22px] items-center">{children}</div>
    </div>
  )
}

export function MacStrip({ load, onOpen }: { load: SystemLoadState; onOpen: () => void }) {
  const online = useShell((s) => s.conn === 'online')
  const last = load.samples[load.samples.length - 1]
  const recent = load.samples.slice(-30)
  const note = problem(load, online)
  if (!load.loaded && !note) {
    if (!online) return null
    return (
      <div className="rounded-[18px] bg-[var(--ws-card)] px-4 py-3 text-[13px] text-[var(--ws-label2)]" data-ws-mac-strip="collecting">
        Reading your desktop's load
      </div>
    )
  }
  if (!load.loaded) return <p className="px-1 text-[13px] leading-snug text-[var(--ws-label2)]" data-ws-mac-strip="error">{note}</p>
  return (
    <button type="button" onClick={onOpen} className={`ws-press flex w-full items-center gap-3 rounded-[18px] bg-[var(--ws-card)] py-3 pl-4 pr-3 text-left ${online ? '' : 'opacity-60'}`} data-ws-mac-strip={online ? 'live' : 'offline'}>
      <Cell label="CPU" value={last ? formatPct(last.cpu) : '—'}>
        <Sparkline values={recent.map((s) => s.cpu)} max={100} surface="var(--ws-card)" />
      </Cell>
      <Cell label="Memory" value={last ? `${formatMem(last.mem)}` : '—'}>
        <Sparkline values={recent.map((s) => s.mem)} max={load.memTotal} surface="var(--ws-card)" />
      </Cell>
      <Cell label="Disk free" value={load.disk ? formatDisk(load.disk.free) : '—'}>
        {load.disk && (
          <div className="w-full pr-1">
            <DiskBar disk={load.disk} height={6} />
          </div>
        )}
      </Cell>
      <ChevronRight size={16} strokeWidth={2.4} className="shrink-0 text-[var(--ws-label3)]" />
    </button>
  )
}

function Card({ title, value, sub, children, data }: { title: string; value: ReactNode; sub?: string; children: ReactNode; data: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-[20px] bg-[var(--ws-card)] px-4 pb-3 pt-3.5" data-ws-mac-card={data}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-[var(--ws-label2)]">{title}</h2>
        <span className="text-[24px] font-semibold leading-none">{value}</span>
      </div>
      {children}
      {sub && <p className="text-[12.5px] text-[var(--ws-label2)]">{sub}</p>}
    </section>
  )
}

export function MacScreen({ load, onClose }: { load: SystemLoadState; onClose: () => void }) {
  const view = useView()
  const hostName = useShell((s) => s.hostName)
  const online = useShell((s) => s.conn === 'online')
  const last = load.samples[load.samples.length - 1]
  const cpu = stats(load.samples.map((s) => s.cpu))
  const mem = stats(load.samples.map((s) => s.mem))
  const note = problem(load, online)
  const chartH = view.landscape ? 120 : 150
  return (
    <div className="ws-scroll ws-screen fixed inset-0 z-[45] bg-black" style={{ paddingTop: view.safe.t, paddingLeft: view.safe.l, paddingRight: view.safe.r, paddingBottom: Math.max(view.safe.b, 16) }} data-ws-page="Mac">
      <div className="mx-auto w-full max-w-[980px]">
        <div className="flex h-[52px] items-center gap-1 px-2">
          <button type="button" aria-label="Back to projects" onClick={onClose} className="flex h-11 items-center gap-0.5 rounded-full pl-1 pr-3 text-[16px] text-[var(--ws-accent)] active:opacity-60" data-ws-mac-back>
            <ChevronLeft size={24} strokeWidth={2.4} />
            Projects
          </button>
        </div>
        <h1 className="truncate px-5 pb-1 text-[30px] font-bold tracking-tight">{hostName || 'Your desktop'}</h1>
        <p className="px-5 pb-4 text-[13.5px] text-[var(--ws-label2)]">{note ?? `Last ${Math.round(load.windowMs / 60_000)} minutes, updated every 2 seconds`}</p>
        <div className="grid gap-3 px-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(380px, 100%), 1fr))' }}>
          <Card title="CPU" value={last ? formatPct(last.cpu) : '—'} sub={load.samples.length > 1 ? `Peak ${formatPct(cpu.peak)} · average ${formatPct(cpu.avg)}${load.cores ? ` · ${load.cores} cores` : ''}` : undefined} data="cpu">
            <LoadChart samples={load.samples} pick={(s) => s.cpu} max={100} windowMs={load.windowMs} height={chartH} ticks={cpuTicks()} format={formatPct} surface="var(--ws-card)" label="CPU" />
          </Card>
          <Card
            title="Memory"
            value={
              <>
                {last ? formatMem(last.mem) : '—'}
                {load.memTotal ? <span className="text-[15px] font-medium text-[var(--ws-label2)]"> of {formatMem(load.memTotal)}</span> : null}
              </>
            }
            sub={load.samples.length > 1 ? `Peak ${formatMem(mem.peak)} · average ${formatMem(mem.avg)}` : undefined}
            data="memory"
          >
            <LoadChart samples={load.samples} pick={(s) => s.mem} max={load.memTotal} windowMs={load.windowMs} height={chartH} ticks={memTicks(load.memTotal)} format={formatMem} surface="var(--ws-card)" label="Memory used" />
          </Card>
          {load.disk && (
            <Card title="Disk" value={null} data="disk">
              <DiskSummary disk={load.disk} />
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
