import type { GraphSvg } from '../../lib/git/scm-history'

export function GitGraphSvg({ graph, stretch }: { graph: GraphSvg; stretch?: boolean }) {
  return (
    <svg
      className="graph shrink-0"
      style={{ height: stretch ? '100%' : graph.height, width: graph.width }}
      viewBox={stretch ? `0 0 ${graph.width} ${graph.height}` : undefined}
      preserveAspectRatio={stretch ? 'none' : undefined}
    >
      {graph.elements.map((el, i) =>
        el.type === 'path' ? (
          <path
            key={i}
            d={el.d}
            fill="none"
            strokeWidth={`${el.strokeWidth}px`}
            strokeLinecap={stretch ? 'butt' : 'round'}
            vectorEffect={stretch ? 'non-scaling-stroke' : undefined}
            style={{ stroke: el.color }}
          />
        ) : (
          <circle
            key={i}
            cx={el.cx}
            cy={el.cy}
            r={el.r}
            style={{
              strokeWidth: `${el.strokeWidth}px`,
              fill: el.fill,
              stroke: el.stroke,
              strokeDasharray: el.dashed ? '4,2' : undefined
            }}
          />
        )
      )}
    </svg>
  )
}
