import type { ReactNode } from 'react'

export function RowIcon({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] text-white" style={{ background: color }}>
      {children}
    </span>
  )
}

export function Group({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="px-4 pb-6">
      {title && <h2 className="px-4 pb-1.5 text-[13px] uppercase tracking-wide text-[var(--ws-label2)]">{title}</h2>}
      <div className="overflow-hidden rounded-[12px] bg-[var(--ws-card)] [&>*+*]:border-t [&>*+*]:border-white/[0.08]">{children}</div>
      {footer && <p className="px-4 pt-1.5 text-[13px] leading-snug text-[var(--ws-label2)]">{footer}</p>}
    </section>
  )
}
