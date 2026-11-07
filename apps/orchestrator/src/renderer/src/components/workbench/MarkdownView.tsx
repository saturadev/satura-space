import { memo, useLayoutEffect, useMemo, useRef, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { DEFAULT_EDITOR_FONT_SIZE } from '@shared/types'
import Markdown, { type Components, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMath from 'remark-math'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import rehypeSlug from 'rehype-slug'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import { markdownSanitizeSchema } from './markdown-sanitize-schema'
import { CodeBlockCopyButton } from './CodeBlockCopyButton'
import { openFileInWorkbench } from '../../lib/editor/open-file'
import { resolveTerminalPath } from '../../lib/terminal/terminal-file-paths'
import { cellFit, hastText } from '../../lib/table-fit'

const MD_BASE_FONT_SIZE = 14

const REMARK_PLUGINS: Options['remarkPlugins'] = [remarkGfm, remarkBreaks, remarkFrontmatter, remarkMath]
const REHYPE_PLUGINS: Options['rehypePlugins'] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  rehypeSlug,
  rehypeHighlight,
  rehypeKatex
]

function localLinkTarget(href: string, filePath: string | undefined): string | null {
  if (!href) return null
  const fileUrl = /^file:/i.test(href)
  if (!fileUrl && !/^[A-Za-z]:[\\/]/.test(href) && /^[a-z][a-z0-9+.-]*:/i.test(href)) return null
  let path = href.replace(/[?#].*$/, '')
  if (fileUrl) path = path.replace(/^file:\/\//i, '').replace(/^\/([A-Za-z]:)/, '$1')
  try {
    path = decodeURIComponent(path)
  } catch {
  }
  if (!path) return null
  const dir = filePath ? filePath.replace(/\\/g, '/').replace(/\/[^/]*$/, '') : undefined
  return resolveTerminalPath(path, dir)
}

function joinClass(...names: (string | undefined)[]): string | undefined {
  return names.filter(Boolean).join(' ') || undefined
}

function useMarkdownComponents(filePath: string | undefined, bodyRef: RefObject<HTMLDivElement | null>): Components {
  return useMemo<Components>(() => {
    const onLinkClick = (e: MouseEvent<HTMLAnchorElement>): void => {
      const href = e.currentTarget.getAttribute('href') ?? ''
      if (href.startsWith('#')) {
        e.preventDefault()
        const id = decodeURIComponent(href.slice(1))
        try {
          bodyRef.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: 'smooth' })
        } catch {
        }
        return
      }
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault()
        window.open(href, '_blank', 'noopener,noreferrer')
        return
      }
      e.preventDefault()
      const target = localLinkTarget(href, filePath)
      if (target) openFileInWorkbench({ file: target, highlight: true })
    }

    return {
      a({ node: _node, ...props }) {
        return <a {...props} onClick={onLinkClick} />
      },
      pre({ node: _node, ...props }) {
        return <CodeBlockCopyButton {...props} />
      },
      td({ node, className, ...props }) {
        return <td {...props} className={joinClass(className, cellFit(hastText(node)))} />
      },
      th({ node, className, ...props }) {
        return <th {...props} className={joinClass(className, cellFit(hastText(node)))} />
      }
    }
  }, [filePath, bodyRef])
}

export function MarkdownBlock({
  content,
  filePath,
  className = '',
  remarkExtra,
  wrapPre
}: {
  content: string
  filePath?: string
  className?: string
  remarkExtra?: NonNullable<Options['remarkPlugins']>
  wrapPre?: (node: ReactNode) => ReactNode
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const base = useMarkdownComponents(filePath, bodyRef)
  const components = useMemo<Components>(() => {
    if (!wrapPre) return base
    return {
      ...base,
      a({ node: _node, ...props }) {
        return <a {...props} />
      },
      pre({ node: _node, ...props }) {
        return <>{wrapPre(<CodeBlockCopyButton {...props} />)}</>
      }
    }
  }, [base, wrapPre])
  const plugins = useMemo(() => (remarkExtra ? [...(REMARK_PLUGINS ?? []), ...remarkExtra] : REMARK_PLUGINS), [remarkExtra])
  return (
    <div ref={bodyRef} className={`satura-markdown markdown-body ${className}`}>
      <Markdown remarkPlugins={plugins} rehypePlugins={REHYPE_PLUGINS} components={components}>
        {content}
      </Markdown>
    </div>
  )
}

const scrollTops = new Map<string, number>()

export default memo(function MarkdownView({
  content,
  filePath,
  fontSize = DEFAULT_EDITOR_FONT_SIZE,
  stateKey
}: {
  content: string
  filePath?: string
  fontSize?: number
  stateKey?: string
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollKey = stateKey ? `${stateKey}\n${filePath ?? ''}` : ''
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el || !scrollKey) return
    const saved = scrollTops.get(scrollKey)
    if (saved) el.scrollTop = saved
    const onScroll = (): void => {
      scrollTops.delete(scrollKey)
      scrollTops.set(scrollKey, el.scrollTop)
      while (scrollTops.size > 200) scrollTops.delete(scrollTops.keys().next().value as string)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollKey])
  const basePx = Math.round((MD_BASE_FONT_SIZE * fontSize * 100) / DEFAULT_EDITOR_FONT_SIZE) / 100
  const components = useMarkdownComponents(filePath, bodyRef)

  return (
    <div
      ref={bodyRef}
      className="satura-markdown markdown-body absolute inset-0 overflow-auto p-6 [container-type:size]"
      style={{ fontSize: `${basePx}px` }}
    >
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
      >
        {content}
      </Markdown>
    </div>
  )
})
