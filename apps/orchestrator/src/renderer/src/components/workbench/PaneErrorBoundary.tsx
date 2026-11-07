import { Component, type ReactNode } from 'react'

export class PaneErrorBoundary extends Component<
  { label?: string; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    if (!this.props.label) return null
    return (
      <div className="absolute inset-0 flex items-center justify-center text-center">
        <div className="flex max-w-md flex-col items-center gap-2 px-6">
          <p className="text-sm text-rose-300">{this.props.label} failed to load</p>
          <p className="break-words text-xs text-zinc-500">{this.state.error.message}</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-1 rounded border border-white/15 px-2 py-0.5 text-xs text-zinc-300 hover:bg-white/10 hover:text-white"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }
}
