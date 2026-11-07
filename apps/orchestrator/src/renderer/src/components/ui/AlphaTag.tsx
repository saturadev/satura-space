export function AlphaTag({ className = '' }: { className?: string }) {
  return (
    <span
      data-alpha
      data-ti-tip="Alpha: expect rough edges and changes between versions"
      className={`shrink-0 whitespace-nowrap rounded-sm px-1 text-[9px] font-semibold uppercase leading-[14px] tracking-wide text-amber-300/90 ring-1 ring-inset ring-amber-300/30 ${className}`}
    >
      Alpha
    </span>
  )
}
