import { Fragment, useEffect, useRef, type ReactNode } from 'react'
import { FloatingMenu, MenuLabel, MenuSeparator, menuItemClass } from '../../components/ui/FloatingMenu'
import type { ActionNode } from './action-tree'

type Presenter = (nodes: ActionNode[], at: { x: number; y: number }, onDismiss: () => void) => () => void

let presenter: Presenter | null = null

export function setActionMenuPresenter(fn: Presenter | null): void {
  presenter = fn
}

export function hasActionMenuPresenter(): boolean {
  return !!presenter
}

function Hint({ children }: { children: ReactNode }) {
  return <span aria-hidden className="ml-auto shrink-0 pl-4 font-mono text-[11px] text-ink-4">{children}</span>
}

export function ActionMenuItems({ nodes, onPicked }: { nodes: ActionNode[]; onPicked: () => void }) {
  return (
    <>
      {nodes.map((n, i) => {
        if (n.children && !n.inline && !n.expand) return null
        if (n.inline && n.children) {
          return (
            <Fragment key={n.id}>
              {i > 0 && <MenuSeparator />}
              {n.header ?? (n.label ? <MenuLabel>{n.label}</MenuLabel> : null)}
              <ActionMenuItems nodes={n.children} onPicked={onPicked} />
              {n.footer}
            </Fragment>
          )
        }
        return (
          <button
            key={n.id}
            className={`${menuItemClass} ${n.desktopClass ?? ''}`}
            disabled={n.enabled === false}
            onClick={(e) => {
              onPicked()
              if (n.expand) n.expand({ x: e.clientX, y: e.clientY })
              else void n.run?.(undefined, { x: e.clientX, y: e.clientY })
            }}
          >
            {n.glyph}
            {n.label}
            {n.hint && <Hint>{n.hint}</Hint>}
          </button>
        )
      })}
    </>
  )
}

export function ActionMenu({ x, y, nodes, onDismiss, className }: { x: number; y: number; nodes: ActionNode[]; onDismiss: () => void; className?: string }) {
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const remote = !!presenter
  useEffect(() => {
    if (!presenter) return
    return presenter(nodesRef.current, { x, y }, onDismiss)
  }, [x, y])
  if (remote) return null
  return (
    <FloatingMenu x={x} y={y} onDismiss={onDismiss} className={className}>
      <ActionMenuItems nodes={nodes} onPicked={onDismiss} />
    </FloatingMenu>
  )
}
