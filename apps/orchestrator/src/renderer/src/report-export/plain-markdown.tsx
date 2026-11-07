import type { ReactNode } from 'react'

export function MarkdownBlock({ content, className = '' }: { content: string; filePath?: string; className?: string; remarkExtra?: unknown; wrapPre?: (node: ReactNode) => ReactNode }) {
  return (
    <div className={className}>
      <p style={{ whiteSpace: 'pre-wrap' }}>{content}</p>
    </div>
  )
}
