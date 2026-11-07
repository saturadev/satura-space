import { useContext, useEffect, useRef, useState, type ReactElement } from 'react'
import type { ScmFileContent } from '@shared/git-scm'
import { loadMonacoKit, type MonacoKit } from '../../lib/editor/monaco-kit'
import { languageFromPath } from '../../lib/editor/language-from-path'
import { activeThemeId } from '../../lib/theme/themes'
import { FullscreenContext } from './Fullscreen'
import { useReport } from './report-context'

const MAX_HEIGHT = 640
const MIN_HEIGHT = 60
let diffSeq = 0

function textOf(c: ScmFileContent | null): { text: string; note: string } {
  if (!c) return { text: '', note: '' }
  if (c.kind === 'text') return { text: c.text, note: '' }
  if (c.kind === 'missing') return { text: '', note: '' }
  if (c.kind === 'binary') return { text: '', note: 'binary file' }
  return { text: '', note: 'file too large to show' }
}

export default function FileDiff(props: { root: string; path: string; oldPath?: string; ref1: string; ref2: string; sideBySide: boolean }): ReactElement {
  const [kit, setKit] = useState<MonacoKit | null>(null)
  const [failed, setFailed] = useState('')
  useEffect(() => {
    let alive = true
    loadMonacoKit().then(
      (k) => alive && setKit(k),
      (e: unknown) => alive && setFailed(e instanceof Error ? e.message : String(e))
    )
    return () => {
      alive = false
    }
  }, [])
  if (failed) return <div className="rk-missing">{`Couldn't load the diff view: ${failed}`}</div>
  if (!kit) return <div className="rk-gd-loading">Loading diff…</div>
  return <MonacoFileDiff {...props} kit={kit} />
}

function MonacoFileDiff({
  root,
  path,
  oldPath,
  ref1,
  ref2,
  sideBySide,
  kit
}: {
  kit: MonacoKit
  root: string
  path: string
  oldPath?: string
  ref1: string
  ref2: string
  sideBySide: boolean
}): ReactElement {
  const { monaco, NO_UNICODE_HIGHLIGHT, defineMonacoThemes, monacoThemeName } = kit
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<ReturnType<typeof monaco.editor.createDiffEditor> | null>(null)
  const [sides, setSides] = useState<{ a: ScmFileContent | null; b: ScmFileContent | null } | null>(null)
  const [error, setError] = useState('')
  const [height, setHeight] = useState(MIN_HEIGHT)
  const full = useContext(FullscreenContext)
  const git = useReport().bridge.git
  const maxHeight = full ? Infinity : MAX_HEIGHT

  useEffect(() => {
    let alive = true
    setSides(null)
    setError('')
    const show = (p: string, ref: string): Promise<ScmFileContent | null> =>
      git.show(root, p, ref).then((r) => (r.ok ? r.value : { kind: 'missing' as const }))
    Promise.all([show(oldPath || path, ref1), show(path, ref2)]).then(
      ([a, b]) => alive && setSides({ a, b }),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e))
    )
    return () => {
      alive = false
    }
  }, [root, path, oldPath, ref1, ref2, git])

  const a = textOf(sides?.a ?? null)
  const b = textOf(sides?.b ?? null)
  const note = a.note || b.note

  useEffect(() => {
    const host = hostRef.current
    if (!host || !sides || note) return
    defineMonacoThemes(monaco)
    const editor = monaco.editor.createDiffEditor(host, {
      readOnly: true,
      originalEditable: false,
      renderSideBySide: sideBySide,
      useInlineViewWhenSpaceIsLimited: true,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 },
      minimap: { enabled: false },
      lineDecorationsWidth: 24,
      lineNumbersMinChars: 4,
      lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off },
      fontSize: 12.5,
      lineHeight: 18,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
      scrollBeyondLastLine: false,
      automaticLayout: true,
      renderOverviewRuler: false,
      scrollbar: { useShadows: false, alwaysConsumeMouseWheel: false, horizontal: 'visible', horizontalScrollbarSize: 10, verticalScrollbarSize: 10 },
      unicodeHighlight: NO_UNICODE_HIGHLIGHT,
      stickyScroll: { enabled: false }
    })
    monaco.editor.setTheme(monacoThemeName(activeThemeId()))
    const lang = languageFromPath(path)
    const seq = ++diffSeq
    const uri = (scheme: string): ReturnType<typeof monaco.Uri.from> => monaco.Uri.from({ scheme, path: `/${path.replace(/^\/+/, '')}`, query: String(seq) })
    const original = monaco.editor.createModel(a.text, lang, uri('satura-report-diff-a'))
    const modified = monaco.editor.createModel(b.text, lang, uri('satura-report-diff-b'))
    editor.setModel({ original, modified })
    const fit = (): void => {
      const eds = [editor.getOriginalEditor(), editor.getModifiedEditor()]
      const h = Math.max(...eds.map((e) => e.getContentHeight() + (e.getScrollWidth() > e.getLayoutInfo().contentWidth + 1 ? e.getLayoutInfo().horizontalScrollbarHeight : 0)))
      setHeight(Math.max(MIN_HEIGHT, Math.min(maxHeight, h + 2)))
    }
    const subs = [
      editor.onDidUpdateDiff(fit),
      editor.getModifiedEditor().onDidContentSizeChange(fit),
      editor.getOriginalEditor().onDidContentSizeChange(fit),
      editor.getModifiedEditor().onDidLayoutChange(fit)
    ]
    editorRef.current = editor
    return () => {
      subs.forEach((s) => s.dispose())
      editorRef.current = null
      editor.setModel(null)
      editor.dispose()
      original.dispose()
      modified.dispose()
    }
  }, [sides, note, path, a.text, b.text, maxHeight])

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: sideBySide })
  }, [sideBySide])

  if (error) return <div className="rk-missing">{error}</div>
  if (!sides) return <div className="rk-gd-loading">Loading diff…</div>
  if (note) return <div className="rk-gd-note">{note}</div>
  return <div ref={hostRef} className="rk-gd-editor" style={{ height }} />
}
