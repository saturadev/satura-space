import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Columns2, FileSymlink, FoldVertical, LoaderCircle, Minus, Plus, Rows2, Undo2, UnfoldVertical } from 'lucide-react'
import type * as Monaco from 'monaco-editor'
import {
  ENV_REF,
  INDEX_REF,
  WORKTREE_REF,
  imageMimeType,
  type ScmFileContent,
  type ScmResult,
  type ScmViewSettings
} from '@shared/git-scm'
import { NO_UNICODE_HIGHLIGHT, monaco } from '../../lib/editor/monaco-setup'
import { chordKey } from '../../lib/shortcuts/chord-key'
import { defineMonacoThemes, monacoThemeName } from '../../lib/editor/monaco-themes'
import { languageFromPath } from '../../lib/editor/language-from-path'
import { activeThemeId } from '../../lib/theme/themes'
import type { DiffSides, GitSide } from '../../lib/git/scm-resource'
import { gitScmApi, type ScmRepository } from './use-scm-repository'
import { requestConfirm } from '../../lib/confirm/confirm-store'
import {
  TextDocument,
  applyLineChanges,
  changeAtLine,
  invertLineChange,
  selectedLineChanges,
  type LineChange
} from '../../lib/git/staging'
import { EnvWarningIcon } from './env-icons'
import { ScmProgressBar } from './ScmProgress'
import { describeDiff, maybeContentOnly, type DiffNote } from '../../lib/git/diff-notes'
import { ScmImageDiff, formatSize } from './ScmImageDiff'
import { Tooltip, useCopyHint } from '../ui/Tooltip'
import { compact as compactNodes, section, usePanelActions } from '../../lib/actions/action-tree'
import { FloatingMenu, MenuSeparator, menuItemClass } from '../ui/FloatingMenu'
import { isMobileLayout } from '../../lib/mobile/mobile-back'
import { joinPath, revealLabel } from '../../lib/git/scm-resource'
import { debugLog } from '@shared/debug-log'

function HeaderButton({
  label,
  active,
  onClick,
  children
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        className={`rounded p-1 hover:bg-white/10 hover:text-ink ${active ? 'bg-white/10 text-ink' : 'text-ink-3'}`}
      >
        {children}
      </button>
    </Tooltip>
  )
}

const QUICK_COMMAND = 'editor.action.quickCommand'
const SEPARATOR = 'vs.actions.separator'

function isPaletteChord(e: KeyboardEvent): boolean {
  if (e.key === 'F1' || e.code === 'F1') return true
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && chordKey(e) === 'p'
}

function withoutPalette<T extends { id?: string }>(actions: T[]): T[] {
  const out: T[] = []
  for (const a of actions) {
    if (a?.id === QUICK_COMMAND) continue
    if (a?.id === SEPARATOR && (out.length === 0 || out[out.length - 1]?.id === SEPARATOR)) continue
    out.push(a)
  }
  while (out.length > 0 && out[out.length - 1]?.id === SEPARATOR) out.pop()
  return out
}

function dropPaletteFromMenu(editor: Monaco.editor.ICodeEditor): void {
  const menu = editor.getContribution('editor.contrib.contextmenu') as unknown as {
    _getMenuActions?: (...args: unknown[]) => Array<{ id?: string }>
  } | null
  const orig = menu?._getMenuActions
  if (!menu || typeof orig !== 'function') return
  menu._getMenuActions = (...args: unknown[]) => withoutPalette(orig.apply(menu, args))
}

function blockCommandPalette(diff: Monaco.editor.IStandaloneDiffEditor): void {
  dropPaletteFromMenu(diff.getOriginalEditor())
  dropPaletteFromMenu(diff.getModifiedEditor())
  const dom = diff.getContainerDomNode()
  const block = (e: KeyboardEvent): void => {
    if (!isPaletteChord(e)) return
    e.preventDefault()
    e.stopImmediatePropagation()
  }
  dom.addEventListener('keydown', block, true)
  diff.onDidDispose(() => dom.removeEventListener('keydown', block, true))
}

export interface DiffRequest {
  readonly key: string
  readonly sides: DiffSides
}

interface TextDiff {
  readonly key: string
  readonly path: string
  readonly original: string
  readonly modified: string
}

type Loaded =
  | ({ readonly kind: 'text'; readonly note?: DiffNote } & TextDiff)
  | { readonly kind: 'message'; readonly key: string; readonly text: string }

interface DiffModels {
  readonly key: string
  readonly original: Monaco.editor.ITextModel
  readonly modified: Monaco.editor.ITextModel
}

let modelSeq = 0

function createModels(diff: TextDiff): DiffModels {
  const seq = ++modelSeq
  const language = languageFromPath(diff.path)
  const uri = (scheme: string): Monaco.Uri => monaco.Uri.from({ scheme, path: `/${diff.path}`, query: String(seq) })
  return {
    key: diff.key,
    original: monaco.editor.createModel(diff.original, language, uri('scm-original')),
    modified: monaco.editor.createModel(diff.modified, language, uri('scm-modified'))
  }
}

function releaseModels(models: DiffModels | null): void {
  if (!models) return
  window.setTimeout(() => {
    models.original.dispose()
    models.modified.dispose()
  }, 0)
}

function syncText(model: Monaco.editor.ITextModel, text: string): void {
  if (model.getValue() !== text) model.setValue(text)
}

type LineMode = 'stage' | 'stageEnv' | 'unstage'
type LineAction = 'stage' | 'unstage' | 'discard'
type LineScope = 'selection' | 'block' | 'change'

const ENV_CONFLICT_LINES_TIP = "These edits touch the same lines as your env edits, so lines can't be staged or discarded in this view. Open the file in Env Changes to discard lines there."

function lineModeOf(sides: DiffSides): LineMode | undefined {
  const { original, modified } = sides
  if (!original || !modified) return undefined
  if (modified.ref === WORKTREE_REF && (original.ref === INDEX_REF || original.ref === 'HEAD') && original.path === modified.path) {
    return 'stage'
  }
  if (modified.ref === ENV_REF && original.ref === INDEX_REF && original.path === modified.path) return 'stageEnv'
  if (modified.ref === INDEX_REF && original.ref === 'HEAD') return 'unstage'
  return undefined
}

function fileName(path: string): string {
  return path.substring(path.lastIndexOf('/') + 1)
}

interface LineActions {
  readonly mode: LineMode | undefined
  readonly run: (action: LineAction, scope: LineScope, change?: LineChange) => Promise<unknown>
}

interface HunkHover {
  readonly change: LineChange
}

function sameChange(a: LineChange | undefined, b: LineChange | undefined): boolean {
  return !!a && !!b &&
    a.originalStartLineNumber === b.originalStartLineNumber &&
    a.originalEndLineNumber === b.originalEndLineNumber &&
    a.modifiedStartLineNumber === b.modifiedStartLineNumber &&
    a.modifiedEndLineNumber === b.modifiedEndLineNumber
}

function hunkAtModified(changes: readonly LineChange[], target: Monaco.editor.IMouseTarget): LineChange | undefined {
  if (target.type === monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE) {
    const after = target.detail.afterLineNumber
    return changes.find((c) =>
      c.modifiedEndLineNumber === 0
        ? c.modifiedStartLineNumber === after
        : c.originalEndLineNumber > 0 && c.modifiedStartLineNumber - 1 === after
    )
  }
  const line = target.position?.lineNumber
  if (!line) return undefined
  return changes.find((c) => c.modifiedEndLineNumber > 0 && line >= c.modifiedStartLineNumber && line <= c.modifiedEndLineNumber)
}

function hunkAtOriginal(changes: readonly LineChange[], target: Monaco.editor.IMouseTarget): LineChange | undefined {
  const line = target.position?.lineNumber
  if (!line) return undefined
  return changes.find((c) => c.originalEndLineNumber > 0 && line >= c.originalStartLineNumber && line <= c.originalEndLineNumber)
}

function wholeLines(start: number, end: number): Monaco.editor.IModelDeltaDecoration[] {
  if (end <= 0) return []
  return [{ range: new monaco.Range(start, 1, end, 1), options: { isWholeLine: true, className: 'scm-hunk-hover' } }]
}

const CORRIDOR = 16

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

function blockBox(editor: Monaco.editor.ICodeEditor, start: number, end: number): Box | undefined {
  const node = editor.getDomNode()
  if (!node) return undefined
  const rect = node.getBoundingClientRect()
  const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight)
  const scroll = editor.getScrollTop()
  const top = end > 0
    ? editor.getTopForLineNumber(Math.max(1, start))
    : start === 0 ? 0 : editor.getTopForLineNumber(start) + lineHeight
  const bottom = end > 0 ? editor.getTopForLineNumber(end) + lineHeight : top
  return {
    left: rect.left,
    right: rect.right,
    top: Math.max(rect.top, Math.min(rect.bottom, rect.top + top - scroll)),
    bottom: Math.max(rect.top, Math.min(rect.bottom, rect.top + bottom - scroll))
  }
}

function union(boxes: (Box | undefined)[]): Box | undefined {
  let out: Box | undefined
  for (const b of boxes) {
    if (!b) continue
    out = out
      ? { left: Math.min(out.left, b.left), top: Math.min(out.top, b.top), right: Math.max(out.right, b.right), bottom: Math.max(out.bottom, b.bottom) }
      : { ...b }
  }
  return out
}

function registerHunkHover(
  diff: Monaco.editor.IStandaloneDiffEditor,
  node: HTMLElement,
  actionsRef: React.MutableRefObject<LineActions>,
  setHover: (hover: HunkHover | null) => void
): () => void {
  const modified = diff.getModifiedEditor()
  const original = diff.getOriginalEditor()
  const modifiedDecorations = modified.createDecorationsCollection()
  const originalDecorations = original.createDecorationsCollection()
  let current: LineChange | undefined
  let clearTimer: number | undefined
  let dragging = false
  let position: { top: number; left: number } | null = null

  const widget: Monaco.editor.IOverlayWidget = {
    getId: () => 'scm.hunkToolbar',
    getDomNode: () => node,
    getPosition: () => (position ? { preference: position } : null)
  }
  node.style.display = 'none'
  modified.addOverlayWidget(widget)

  const relayout = (): void => {
    if (!current) {
      position = null
      node.style.display = 'none'
      modified.layoutOverlayWidget(widget)
      return
    }
    const change = current
    const layout = modified.getLayoutInfo()
    const lineHeight = modified.getOption(monaco.editor.EditorOption.lineHeight)
    const deletion = change.modifiedEndLineNumber === 0
    const line = Math.max(1, change.modifiedStartLineNumber)
    const inEditor = deletion
      ? change.modifiedStartLineNumber === 0 ? 0 : modified.getTopForLineNumber(line) + lineHeight
      : modified.getTopForLineNumber(line)
    const height = node.offsetHeight || 24
    const top = Math.max(0, Math.min(layout.height - height, inEditor - modified.getScrollTop() + 1))
    const left = Math.max(0, layout.width - layout.verticalScrollbarWidth - layout.minimap.minimapWidth - (node.offsetWidth || 120) - 8)
    node.style.display = ''
    position = { top, left }
    modified.layoutOverlayWidget(widget)
  }

  const show = (change: LineChange | undefined): void => {
    window.clearTimeout(clearTimer)
    clearTimer = undefined
    if (sameChange(change, current) || (!change && !current)) return
    current = change
    if (!change) {
      modifiedDecorations.clear()
      originalDecorations.clear()
      setHover(null)
      relayout()
      return
    }
    modifiedDecorations.set(wholeLines(change.modifiedStartLineNumber, change.modifiedEndLineNumber))
    originalDecorations.set(wholeLines(change.originalStartLineNumber, change.originalEndLineNumber))
    setHover({ change })
    relayout()
    window.requestAnimationFrame(relayout)
  }

  const release = (): void => {
    if (clearTimer !== undefined) return
    clearTimer = window.setTimeout(() => {
      clearTimer = undefined
      show(undefined)
    }, 150)
  }

  const keep = (): void => {
    window.clearTimeout(clearTimer)
    clearTimer = undefined
  }

  const corridor = (): Box | undefined => {
    if (!current) return undefined
    const sideBySide = original.getLayoutInfo().width > 0
    const box = union([
      blockBox(modified, current.modifiedStartLineNumber, current.modifiedEndLineNumber),
      sideBySide ? blockBox(original, current.originalStartLineNumber, current.originalEndLineNumber) : undefined,
      node.style.display === 'none' ? undefined : node.getBoundingClientRect()
    ])
    return box && { left: box.left - CORRIDOR, top: box.top - CORRIDOR, right: box.right + CORRIDOR, bottom: box.bottom + CORRIDOR }
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (!current || dragging) return
    const box = corridor()
    if (box && e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom) keep()
    else release()
  }

  const onMove = (find: (changes: readonly LineChange[], target: Monaco.editor.IMouseTarget) => LineChange | undefined) =>
    (e: Monaco.editor.IEditorMouseEvent): void => {
      if (dragging || e.event.buttons !== 0) return
      if (!actionsRef.current.mode) {
        show(undefined)
        return
      }
      if (e.target.type === monaco.editor.MouseTargetType.OVERLAY_WIDGET) return
      const change = find(diff.getLineChanges() ?? [], e.target)
      if (change) show(change)
    }

  const onDown = (e: Monaco.editor.IEditorMouseEvent): void => {
    if (e.target.type === monaco.editor.MouseTargetType.OVERLAY_WIDGET) return
    if (!e.event.leftButton) return
    dragging = true
    show(undefined)
  }
  const onUp = (): void => {
    dragging = false
  }
  const reset = (): void => show(undefined)

  window.addEventListener('mouseup', onUp)
  document.addEventListener('pointermove', onPointerMove, true)
  const disposables = [
    modified.onMouseMove(onMove(hunkAtModified)),
    original.onMouseMove(onMove(hunkAtOriginal)),
    modified.onMouseDown(onDown),
    original.onMouseDown(onDown),
    modified.onDidScrollChange(relayout),
    modified.onDidLayoutChange(relayout),
    diff.onDidUpdateDiff(reset),
    modified.onDidChangeModel(reset)
  ]

  return () => {
    window.clearTimeout(clearTimer)
    window.removeEventListener('mouseup', onUp)
    document.removeEventListener('pointermove', onPointerMove, true)
    for (const d of disposables) d.dispose()
    modifiedDecorations.clear()
    originalDecorations.clear()
    modified.removeOverlayWidget(widget)
  }
}

function HunkToolbar({
  mode,
  running,
  onAction
}: {
  mode: LineMode
  running: LineAction | null
  onAction: (action: LineAction) => void
}) {
  const button = (action: LineAction, label: string, Icon: typeof Plus) => (
    <button
      type="button"
      disabled={running !== null}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onClick={(e) => {
        e.stopPropagation()
        onAction(action)
      }}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-2 hover:bg-white/10 hover:text-ink disabled:opacity-60 disabled:hover:bg-transparent"
    >
      {running === action ? <LoaderCircle size={12} className="animate-spin" /> : <Icon size={12} />} {label}
    </button>
  )
  return (
    <div className="surface-overlay flex items-center gap-0.5 rounded-md p-px">
      {mode === 'unstage' ? (
        button('unstage', 'Unstage', Minus)
      ) : (
        <>
          {button('stage', 'Stage', Plus)}
          {button('discard', 'Discard', Undo2)}
        </>
      )}
    </div>
  )
}

function registerLineActions(
  diff: Monaco.editor.IStandaloneDiffEditor,
  actionsRef: React.MutableRefObject<LineActions>
): () => void {
  const editor = diff.getModifiedEditor()
  const modeKey = editor.createContextKey<string>('scmLineMode', '')
  const selectionKey = editor.createContextKey<boolean>('scmLineSelection', false)
  const hunkKey = editor.createContextKey<boolean>('scmLineHunk', false)
  const update = (): void => {
    const mode = actionsRef.current.mode
    modeKey.set(mode === 'stageEnv' ? 'stage' : (mode ?? ''))
    const selections = editor.getSelections() ?? []
    selectionKey.set(selections.some((sel) => !sel.isEmpty()))
    const position = editor.getPosition()
    const changes = diff.getLineChanges() ?? []
    const model = editor.getModel()
    hunkKey.set(
      !!mode && !!position && !!model &&
        !!changeAtLine(new TextDocument(model.getValue()), changes, position.lineNumber - 1)
    )
  }
  const add = (id: string, label: string, when: string, order: number, action: LineAction, scope: LineScope) =>
    editor.addAction({
      id,
      label,
      precondition: when,
      contextMenuGroupId: '0_scm',
      contextMenuOrder: order,
      run: () => void actionsRef.current.run(action, scope)
    })
  const disposables = [
    add('scm.stageSelectedLines', 'Stage Selected Lines', "scmLineMode == 'stage' && scmLineSelection", 1, 'stage', 'selection'),
    add('scm.stageBlock', 'Stage Block', "scmLineMode == 'stage' && !scmLineSelection && scmLineHunk", 1, 'stage', 'block'),
    add('scm.discardSelectedLines', 'Discard Selected Lines', "scmLineMode == 'stage' && scmLineSelection", 2, 'discard', 'selection'),
    add('scm.discardBlock', 'Discard Block', "scmLineMode == 'stage' && !scmLineSelection && scmLineHunk", 2, 'discard', 'block'),
    add('scm.unstageSelectedLines', 'Unstage Selected Lines', "scmLineMode == 'unstage' && scmLineSelection", 1, 'unstage', 'selection'),
    add('scm.unstageBlock', 'Unstage Block', "scmLineMode == 'unstage' && !scmLineSelection && scmLineHunk", 1, 'unstage', 'block'),
    editor.onDidChangeCursorSelection(update),
    editor.onDidChangeModel(update),
    diff.onDidUpdateDiff(update)
  ]
  update()
  return () => {
    for (const d of disposables) d.dispose()
  }
}

function viewOptions(sideBySide: boolean, hideUnchanged: boolean): Monaco.editor.IDiffEditorOptions {
  return {
    renderSideBySide: sideBySide,
    hideUnchangedRegions: {
      enabled: hideUnchanged,
      contextLineCount: 3,
      minimumLineCount: 3,
      revealLineCount: 20
    }
  }
}

function MonacoDiffView({
  diff,
  sideBySide,
  hideUnchanged,
  exactWhitespace,
  actionsRef,
  onEditor,
  phone
}: {
  diff: TextDiff | null
  sideBySide: boolean
  hideUnchanged: boolean
  exactWhitespace: boolean
  actionsRef: React.MutableRefObject<LineActions>
  onEditor: (editor: Monaco.editor.IStandaloneDiffEditor | null) => void
  phone?: boolean
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null)
  const modelsRef = useRef<DiffModels | null>(null)
  const initial = useRef(viewOptions(sideBySide, hideUnchanged))
  const [hover, setHover] = useState<HunkHover | null>(null)
  const [computedKey, setComputedKey] = useState<string | null>(null)
  const [running, setRunning] = useState<LineAction | null>(null)
  const [toolbarNode] = useState(() => {
    const node = document.createElement('div')
    node.className = 'scm-hunk-toolbar'
    return node
  })
  const theme = monacoThemeName(activeThemeId())

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    defineMonacoThemes(monaco)
    const editor = monaco.editor.createDiffEditor(host, {
      ...initial.current,
      readOnly: true,
      originalEditable: false,
      useInlineViewWhenSpaceIsLimited: false,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
      scrollBeyondLastLine: false,
      automaticLayout: true,
      renderOverviewRuler: true,
      scrollbar: { useShadows: false },
      unicodeHighlight: NO_UNICODE_HIGHLIGHT,
      ...(phone
        ? {
            fontSize: 12,
            lineHeight: 18,
            wordWrap: 'on' as const,
            diffWordWrap: 'on' as const,
            lineNumbersMinChars: 3,
            lineDecorationsWidth: 4,
            folding: false,
            glyphMargin: false,
            renderOverviewRuler: false,
            scrollbar: { useShadows: false, verticalScrollbarSize: 4, horizontalScrollbarSize: 4 }
          }
        : {})
    })
    blockCommandPalette(editor)
    const unregister = registerLineActions(editor, actionsRef)
    const disposeHover = registerHunkHover(editor, toolbarNode, actionsRef, setHover)
    const computed = editor.onDidUpdateDiff(() => setComputedKey(modelsRef.current?.key ?? null))
    editorRef.current = editor
    onEditor(editor)
    return () => {
      const models = modelsRef.current
      unregister()
      disposeHover()
      computed.dispose()
      onEditor(null)
      editorRef.current = null
      modelsRef.current = null
      editor.setModel(null)
      editor.dispose()
      releaseModels(models)
    }
  }, [])

  useEffect(() => {
    monaco.editor.setTheme(theme)
  }, [theme])

  useEffect(() => {
    editorRef.current?.updateOptions(viewOptions(sideBySide, hideUnchanged))
  }, [sideBySide, hideUnchanged])

  useEffect(() => {
    editorRef.current?.updateOptions({ ignoreTrimWhitespace: !exactWhitespace })
  }, [exactWhitespace])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const current = modelsRef.current
    if (!diff) {
      if (!current) return
      modelsRef.current = null
      editor.setModel(null)
      releaseModels(current)
      return
    }
    if (current?.key === diff.key) {
      syncText(current.original, diff.original)
      syncText(current.modified, diff.modified)
      return
    }
    const next = createModels(diff)
    modelsRef.current = next
    editor.setModel({ original: next.original, modified: next.modified })
    releaseModels(current)
    const fallback = window.setTimeout(() => {
      if (modelsRef.current === next) setComputedKey(next.key)
    }, 5000)
    return () => window.clearTimeout(fallback)
  }, [diff])

  const mode = actionsRef.current.mode
  return (
    <>
      <div ref={hostRef} className="absolute inset-0" style={diff ? undefined : { display: 'none' }} />
      {diff && computedKey !== diff.key && (
        <div className="absolute inset-0 z-20 flex items-center justify-center gap-2 bg-editor-surface text-sm text-ink-3">
          <LoaderCircle size={14} className="animate-spin" /> Loading changes…
        </div>
      )}
      {diff && hover && mode &&
        createPortal(
          <HunkToolbar
            mode={mode}
            running={running}
            onAction={(action) => {
              setRunning(action)
              void actionsRef.current.run(action, 'change', hover.change).finally(() => setRunning(null))
            }}
          />,
          toolbarNode
        )}
    </>
  )
}

async function load(root: string, side: GitSide | undefined): Promise<ScmResult<ScmFileContent>> {
  if (!side) return { ok: true, value: { kind: 'text', text: '' } }
  return gitScmApi().show(root, side.path, side.ref)
}

export function ScmDiffEditor({
  root,
  repo,
  request,
  version,
  settings,
  onSettings,
  onOpenFile,
  actionScope,
  phone
}: {
  root: string
  repo?: ScmRepository
  request: DiffRequest | null
  version: number
  settings: ScmViewSettings
  onSettings: (patch: Partial<ScmViewSettings>) => void
  onOpenFile?: (path: string) => void
  actionScope?: string
  phone?: boolean
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const sideBySide = settings.diffSideBySide && !isMobileLayout()
  const hideUnchanged = settings.diffHideUnchanged
  const setSideBySide = (value: boolean): void => onSettings({ diffSideBySide: value })
  const setHideUnchanged = (value: boolean): void => onSettings({ diffHideUnchanged: value })
  const { hint: copyHint, copy } = useCopyHint()
  const [pathMenu, setPathMenu] = useState<{ x: number; y: number } | null>(null)
  const path = request ? (request.sides.modified?.path ?? request.sides.original?.path ?? '') : ''
  const image = imageMimeType(path) !== undefined
  const requestedMode = request && repo ? lineModeOf(request.sides) : undefined
  const envConflict = requestedMode === 'stageEnv' && !!repo?.state?.envResidual.some((r) => r.path === path && r.conflict)
  const lineMode = envConflict ? undefined : requestedMode
  const diffEditorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null)
  const editorSubs = useRef<Monaco.IDisposable[]>([])
  const [hunkTick, setHunkTick] = useState(0)
  const autoHunkKey = useRef<string | null>(null)

  useEffect(() => {
    if (!request || image) {
      setLoaded(null)
      return
    }
    let cancelled = false
    const key = request.key
    const originalSide = lineMode === 'stage' && request.sides.original
      ? { ...request.sides.original, ref: INDEX_REF }
      : request.sides.original
    void Promise.all([load(root, originalSide), load(root, request.sides.modified)]).then(
      async ([original, modified]) => {
        if (cancelled) return
        for (const r of [original, modified]) {
          if (!r.ok) {
            setLoaded({ kind: 'message', key, text: r.error.message })
            return
          }
        }
        const o = original.ok ? original.value : null
        const m = modified.ok ? modified.value : null
        for (const c of [o, m]) {
          if (c?.kind === 'binary') {
            setLoaded({ kind: 'message', key, text: `Binary file (${formatSize(c.size)}), no text diff.` })
            return
          }
          if (c?.kind === 'tooLarge') {
            setLoaded({ kind: 'message', key, text: `File is too large to diff (${formatSize(c.size)}).` })
            return
          }
        }
        const originalText = o?.kind === 'text' ? o.text : ''
        const modifiedText = m?.kind === 'text' ? m.text : ''
        const sides = request.sides
        const explained = originalSide && sides.modified
          ? await gitScmApi().explainDiff(
              root,
              sides.modified.path,
              originalSide.path,
              originalSide.ref,
              sides.modified.ref,
              maybeContentOnly(originalText, modifiedText)
            )
          : undefined
        if (cancelled) return
        const note = originalSide && sides.modified
          ? describeDiff(originalText, modifiedText, originalSide.path, sides.modified.path, explained?.ok ? explained.value : undefined)
          : undefined
        const next: Loaded = {
          kind: 'text',
          key,
          path,
          original: originalText,
          modified: modifiedText,
          note
        }
        setLoaded((prev) =>
          prev?.kind === 'text' && prev.key === next.key && prev.original === next.original && prev.modified === next.modified &&
            prev.note?.text === next.note?.text
            ? prev
            : next
        )
      }
    )
    return () => {
      cancelled = true
    }
  }, [root, request, version, image, lineMode])

  const [revealed, setRevealed] = useState<string | null>(null)
  const current = request && !image && loaded?.key === request.key ? loaded : null
  const loadingDiff = !!request && !image && !current
  const note = current?.kind === 'text' && current.note && !(current.note.reveal && revealed === current.key) ? current.note : undefined
  const text = current?.kind === 'text' && !note ? current : null
  const showingWhitespace = !!text?.note && text.note.reveal === 'whitespace'
  const activeMode = text && request && text.key === request.key ? lineMode : undefined

  const lineChanges = (): LineChange[] => (text ? diffEditorRef.current?.getLineChanges() ?? [] : [])
  const changeStart = (c: LineChange): number => Math.max(1, c.modifiedStartLineNumber)
  const cursorLine = (): number => diffEditorRef.current?.getModifiedEditor().getPosition()?.lineNumber ?? 0
  const hunkAt = (changes: LineChange[], line: number): number =>
    changes.findIndex((c) => line >= changeStart(c) && line <= Math.max(changeStart(c), c.modifiedEndLineNumber))
  const goToHunk = (index: number): void => {
    const editor = diffEditorRef.current?.getModifiedEditor()
    const change = lineChanges()[index]
    if (!editor || !change) return
    const line = changeStart(change)
    editor.setPosition({ lineNumber: line, column: 1 })
    editor.revealLineInCenter(line)
    if (isMobileLayout()) debugLog(`[diff] change ${index + 1} of ${lineChanges().length} at line ${line}`)
  }
  const stepHunk = (dir: 1 | -1): void => {
    const changes = lineChanges()
    if (changes.length === 0) throw new Error('This diff has no changes')
    const line = cursorLine()
    const at = hunkAt(changes, line)
    const from = at >= 0 ? changeStart(changes[at]) : line
    let next = -1
    changes.forEach((c, i) => {
      if (dir > 0 ? next < 0 && changeStart(c) > from : changeStart(c) < from) next = i
    })
    if (next < 0) next = dir > 0 ? 0 : changes.length - 1
    goToHunk(next)
  }
  void hunkTick
  const hunkChanges = lineChanges()
  const hunkIndex = hunkAt(hunkChanges, cursorLine())
  const hunkHint = hunkChanges.length ? `${hunkIndex >= 0 ? hunkIndex + 1 : '–'} of ${hunkChanges.length}` : undefined

  useEffect(() => {
    if (!isMobileLayout() || !text || autoHunkKey.current === text.key) return
    if (lineChanges().length === 0) return
    autoHunkKey.current = text.key
    goToHunk(0)
  }, [hunkTick, text?.key])

  const runLines = async (action: LineAction, scope: LineScope, target?: LineChange): Promise<boolean> => {
    const editor = diffEditorRef.current
    if (!repo || !text || !activeMode || !editor) return false
    const changes: LineChange[] = editor.getLineChanges() ?? []
    if (changes.length === 0) return false
    const originalDoc = new TextDocument(text.original)
    const modifiedDoc = new TextDocument(text.modified)
    const modifiedEditor = editor.getModifiedEditor()
    if (modifiedEditor.getModel()?.getLineCount() !== modifiedDoc.lineCount) return false
    let selected: LineChange[]
    if (scope === 'selection') {
      const selections = (modifiedEditor.getSelections() ?? []).map((sel) => ({
        startLine: sel.startLineNumber - 1,
        endLine: sel.endLineNumber - 1
      }))
      selected = selectedLineChanges(modifiedDoc, changes, selections)
    } else if (scope === 'change') {
      selected = target && changes.some((c) => sameChange(c, target)) ? [target] : []
    } else {
      const position = modifiedEditor.getPosition()
      const change = position ? changeAtLine(modifiedDoc, changes, position.lineNumber - 1) : undefined
      selected = change ? [change] : []
    }
    if (selected.length === 0) return false
    const filePath = text.path
    const api = repo.api
    if (action === 'stage' && (activeMode === 'stage' || activeMode === 'stageEnv')) {
      const result = applyLineChanges(originalDoc, modifiedDoc, selected)
      await repo.run('Stage', () => api.stageContent(root, filePath, result), [filePath])
    } else if (action === 'unstage' && activeMode === 'unstage') {
      const result = applyLineChanges(modifiedDoc, originalDoc, selected.map(invertLineChange))
      await repo.run('Unstage', () => api.stageContent(root, filePath, result, true), [filePath])
    } else if (action === 'discard' && (activeMode === 'stage' || activeMode === 'stageEnv')) {
      const ok = await requestConfirm({
        title: 'Discard Changes',
        message:
          scope === 'selection'
            ? `Discard the selected lines in "${fileName(filePath)}"? You can't undo this.`
            : `Discard this block in "${fileName(filePath)}"? You can't undo this.`,
        confirmLabel: 'Discard'
      })
      if (!ok) return true
      const result = applyLineChanges(modifiedDoc, originalDoc, selected.map(invertLineChange))
      const expected = text.modified
      await repo.run('Discard', () =>
        activeMode === 'stageEnv' ? api.discardEnvLines(root, filePath, result, expected) : api.writeFile(root, filePath, result, expected),
        [filePath]
      )
    }
    return true
  }

  const actionsRef = useRef<LineActions>({ mode: undefined, run: async () => undefined })
  actionsRef.current = { mode: activeMode, run: runLines }
  const lineNode = (id: string, label: string, action: LineAction, scope: LineScope, icon: string, destructive = false) => ({
    id,
    label,
    icon,
    destructive,
    primary: scope === 'block' && isMobileLayout(),
    run: async () => {
      if (!(await runLines(action, scope))) throw new Error(scope === 'block' ? 'Move to a change first' : 'Select changed lines first')
    }
  })
  usePanelActions(
    actionScope,
    !request
      ? []
      : compactNodes([
          !!text &&
            section('hunks', [
              { id: 'diff.prevChange', label: 'Previous Change', icon: 'chevron.up', hint: hunkHint, shortcut: 'shift+alt+f5', primary: isMobileLayout(), enabled: hunkChanges.length > 0, run: () => stepHunk(-1) },
              { id: 'diff.nextChange', label: 'Next Change', icon: 'chevron.down', hint: hunkHint, shortcut: 'alt+f5', primary: isMobileLayout(), enabled: hunkChanges.length > 0, run: () => stepHunk(1) }
            ]),
          section('diff', [
            onOpenFile && !!request.sides.modified && { id: 'diff.openFile', label: 'Open File', icon: 'doc.text', primary: !text || !isMobileLayout(), run: () => onOpenFile(path) },
            !!text && { id: 'diff.hideUnchanged', label: hideUnchanged ? 'Show Full File' : 'Show Changed Lines Only', icon: hideUnchanged ? 'arrow.up.and.down.text.horizontal' : 'rectangle.compress.vertical', checked: hideUnchanged, run: () => setHideUnchanged(!hideUnchanged) },
            !!text && {
              id: 'diff.layout',
              label: 'Layout',
              icon: 'rectangle.split.2x1',
              children: [
                { id: 'diff.sideBySide', label: 'Side by Side', checked: sideBySide, enabled: !isMobileLayout(), run: () => setSideBySide(true) },
                { id: 'diff.inline', label: 'Inline', checked: !sideBySide, run: () => setSideBySide(false) }
              ]
            }
          ]),
          !!activeMode &&
            section(
              'lines',
              activeMode === 'unstage'
                ? [lineNode('diff.unstageSelected', 'Unstage Selected Lines', 'unstage', 'selection', 'minus'), lineNode('diff.unstageBlock', 'Unstage Block', 'unstage', 'block', 'minus.square')]
                : [
                    lineNode('diff.stageSelected', 'Stage Selected Lines', 'stage', 'selection', 'plus'),
                    lineNode('diff.stageBlock', 'Stage Block', 'stage', 'block', 'plus.square'),
                    lineNode('diff.discardSelected', 'Discard Selected Lines', 'discard', 'selection', 'arrow.uturn.backward', true),
                    lineNode('diff.discardBlock', 'Discard Block', 'discard', 'block', 'arrow.uturn.backward.square', true)
                  ]
            ),
          section('path', [
            { id: 'diff.reveal', label: revealLabel(), icon: 'folder', run: () => void gitScmApi().revealInFolder(root, path) },
            { id: 'diff.copyPath', label: 'Copy Path', icon: 'doc.on.doc', run: (_v?: string, at?: { x: number; y: number }) => copy(joinPath(root, path), at?.x ?? 0, at?.y ?? 0) },
            { id: 'diff.copyRelPath', label: 'Copy Relative Path', icon: 'doc.on.clipboard', run: (_v?: string, at?: { x: number; y: number }) => copy(path, at?.x ?? 0, at?.y ?? 0) }
          ])
        ])
  )
  const message = current?.kind === 'message' ? current.text : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      {request && !phone && (
        <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-hairline bg-canvas px-3 text-[13px]">
          <span className="truncate text-ink">{request.sides.title}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-ink-3">
            <span
              className="truncate rounded px-0.5 hover:bg-white/10 hover:text-ink-2"
              onContextMenu={(e) => {
                e.preventDefault()
                setPathMenu({ x: e.clientX, y: e.clientY })
              }}
            >
              {path}
            </span>
          </span>
          {copyHint}
          {pathMenu && (
            <FloatingMenu x={pathMenu.x} y={pathMenu.y} onDismiss={() => setPathMenu(null)}>
              <button
                className={menuItemClass}
                onClick={() => {
                  void gitScmApi().revealInFolder(root, path)
                  setPathMenu(null)
                }}
              >
                {revealLabel()}
              </button>
              <MenuSeparator />
              <button
                className={menuItemClass}
                onClick={(e) => {
                  copy(joinPath(root, path), e.clientX, e.clientY)
                  setPathMenu(null)
                }}
              >
                Copy Path
              </button>
              <button
                className={menuItemClass}
                onClick={(e) => {
                  copy(path, e.clientX, e.clientY)
                  setPathMenu(null)
                }}
              >
                Copy Relative Path
              </button>
            </FloatingMenu>
          )}
          {envConflict && (
            <Tooltip label={ENV_CONFLICT_LINES_TIP}>
              <span className="flex shrink-0 items-center gap-1 text-xs text-ink-3">
                <EnvWarningIcon size={13} /> No line actions
              </span>
            </Tooltip>
          )}
          {onOpenFile && request.sides.modified && (
            <HeaderButton label="Open File" onClick={() => onOpenFile(path)}>
              <FileSymlink size={14} />
            </HeaderButton>
          )}
          {text && (
            <div className="flex shrink-0 items-center gap-0.5">
              <HeaderButton
                label={hideUnchanged ? 'Show Full File' : 'Show Changed Lines Only'}
                onClick={() => setHideUnchanged(!hideUnchanged)}
              >
                {hideUnchanged ? <UnfoldVertical size={14} /> : <FoldVertical size={14} />}
              </HeaderButton>
              <div className="mx-1 h-4 w-px bg-hairline" />
              <HeaderButton label="Side by Side" active={sideBySide} onClick={() => setSideBySide(true)}>
                <Columns2 size={14} />
              </HeaderButton>
              <HeaderButton label="Inline" active={!sideBySide} onClick={() => setSideBySide(false)}>
                <Rows2 size={14} />
              </HeaderButton>
            </div>
          )}
        </div>
      )}
      <div className={`relative min-h-0 flex-1 ${request ? 'bg-editor-surface' : ''}`}>
        <ScmProgressBar progress={repo?.progress ?? []} className="top-0" />
        <MonacoDiffView
          diff={text}
          sideBySide={sideBySide}
          hideUnchanged={hideUnchanged}
          exactWhitespace={!!lineMode || showingWhitespace}
          actionsRef={actionsRef}
          phone={phone}
          onEditor={(editor) => {
            for (const d of editorSubs.current) d.dispose()
            editorSubs.current = editor
              ? [
                  editor.getModifiedEditor().onDidChangeCursorPosition(() => setHunkTick((t) => t + 1)),
                  editor.onDidUpdateDiff(() => setHunkTick((t) => t + 1))
                ]
              : []
            diffEditorRef.current = editor
          }}
        />
        {!request ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-4">
            Select a change to see its diff
          </div>
        ) : image ? (
          <div className="absolute inset-0">
            <ScmImageDiff key={request.key} root={root} request={request} version={version} />
          </div>
        ) : loadingDiff ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-ink-3">
            <LoaderCircle size={14} className="animate-spin" /> Loading changes…
          </div>
        ) : message !== null ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-3">{message}</div>
        ) : note && current ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-sm text-ink-3">
            <span className="max-w-[520px]">{note.text}</span>
            {note.reveal && (
              <button
                type="button"
                className="rounded border border-white/10 px-2 py-0.5 text-xs text-ink-2 hover:bg-white/10 hover:text-ink"
                onClick={() => setRevealed(current.key)}
              >
                {note.reveal === 'whitespace' ? 'Show whitespace changes' : 'Show diff'}
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
