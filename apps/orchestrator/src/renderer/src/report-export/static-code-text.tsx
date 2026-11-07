import { useLayoutEffect, useRef, type ReactElement } from 'react'

export default function CodeText({ rel, text, line, endLine }: { path: string; rel: string; text: string; root: string; line?: number; endLine?: number }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const from = line ?? 0
  const to = endLine && line && endLine > line ? endLine : from
  useLayoutEffect(() => {
    const host = ref.current
    const row = host?.querySelector<HTMLElement>(`[data-line="${from}"]`)
    if (host && row) host.scrollTop = Math.max(0, row.offsetTop - host.clientHeight / 3)
  }, [from, rel])
  return (
    <div className="rk-sc" ref={ref} data-static-code={rel}>
      <table className="rk-sd">
        <tbody>
          {lines.map((l, i) => {
            const n = i + 1
            const hl = from > 0 && n >= from && n <= to
            return (
              <tr key={i} data-line={n} className={hl ? 'rk-code-hl' : undefined}>
                <td className={`rk-sd-no ${hl ? 'rk-code-hl-gutter' : ''}`}>{n}</td>
                <td className="rk-sd-text">{l}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
