import type { ReactNode } from 'react'
import { Minus, Plus, X } from 'lucide-react'
import type { FrRect } from '@shared/remote-frame'

export function Cluster({ rect, axis, children }: { rect: FrRect; axis: 'row' | 'column'; children: ReactNode }): React.JSX.Element {
  return (
    <div
      className={`gi-cluster absolute z-[8] flex gap-1 ${axis === 'column' ? 'flex-col' : 'flex-row-reverse'}`}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      data-gi-chrome="cluster"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}

export function IconButton({ label, on, onClick, children, badge, testid }: { label: string; on?: boolean; onClick: () => void; children: ReactNode; badge?: number; testid: string }): React.JSX.Element {
  return (
    <button type="button" tabIndex={-1} className={`gi-icon relative ${on ? 'gi-icon-on' : ''}`} aria-label={label} title={label} data-gi-icon={testid} onClick={onClick}>
      {children}
      {badge ? <span className="gi-badge">{badge}</span> : null}
    </button>
  )
}

export function Panel({ rect, title, onClose, children }: { rect: FrRect; title: string; onClose: () => void; children: ReactNode }): React.JSX.Element {
  return (
    <div className="gi-panel absolute z-[8] flex flex-col" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} data-gi-chrome="panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between py-1.5 pl-3 pr-1.5">
        <span className="text-[13px] font-medium text-ink">{title}</span>
        <button type="button" className="gi-chip" onClick={onClose} aria-label="Close" data-gi-panel-close>
          <X size={15} />
        </button>
      </div>
      <div className="gi-panel-body flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2.5 pb-3">{children}</div>
    </div>
  )
}

export function Stepper({ label, value, step, min, max, onChange, testid }: { label: string; value: number; step: number; min: number; max: number; onChange: (v: number) => void; testid: string }): React.JSX.Element {
  const set = (v: number): void => onChange(Math.min(max, Math.max(min, Math.round(v * 100) / 100)))
  return (
    <div className="flex items-center gap-1.5" data-gi-stepper={testid}>
      <span className="flex-1 px-0.5 text-[12.5px] text-ink-2">{label}</span>
      <button type="button" className="gi-menu-icon" onClick={() => set(value - step)} aria-label={`${label} down`}>
        <Minus size={14} />
      </button>
      <span className="w-10 text-center text-[12.5px] tabular-nums text-ink">{value.toFixed(2)}</span>
      <button type="button" className="gi-menu-icon" onClick={() => set(value + step)} aria-label={`${label} up`}>
        <Plus size={14} />
      </button>
    </div>
  )
}

export function Toggle({ label, value, onChange, testid }: { label: string; value: boolean; onChange: (v: boolean) => void; testid: string }): React.JSX.Element {
  return (
    <button type="button" className="flex items-center justify-between rounded-md px-0.5 py-1 text-left" onClick={() => onChange(!value)} data-gi-toggle={testid} aria-pressed={value}>
      <span className="text-[12.5px] text-ink-2">{label}</span>
      <span className={`gi-switch ${value ? 'gi-switch-on' : ''}`} />
    </button>
  )
}
