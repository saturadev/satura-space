import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react'
import { ArrowDown, ArrowUp, GitCommitHorizontal, LoaderCircle, TriangleAlert } from 'lucide-react'
import type { BlameRange } from '@shared/api'
import type { ThemeId } from '@shared/types'
import { findHotReloadableRanges, rangeFullyInsideBody } from '@shared/unity/csharp-bodies'
import { NO_UNICODE_HIGHLIGHT, monaco } from '../../lib/editor/monaco-setup'
import { defineMonacoThemes, monacoThemeName } from '../../lib/editor/monaco-themes'
import { chordKey } from '../../lib/shortcuts/chord-key'
import { consumeGoto, subscribeGoto } from '../../lib/editor/goto-line'
import { registerMonacoEditor } from '../../lib/editor/monaco-editor-registry'
import { relativePath } from '../../lib/file-explorer/copy-paths'
import { BlameGutter, BlameSheet } from './BlameGutter'
import { useAppStore } from '../../store'
import { Tooltip } from '../ui/Tooltip'
import { FloatingMenu, MenuSeparator, menuItemClass } from '../ui/FloatingMenu'
import {
  MERGE_CONFLICT_COMMANDS,
  attachMergeConflicts,
  type MergeConflictCompareRequest
} from '../../lib/editor/merge-conflict/services'
import { MergeConflictCompare } from '../../lib/editor/merge-conflict/MergeConflictCompare'
import { censusTrack } from '@shared/census'
import { isIdeaChord } from '../../lib/editor/idea-bindings'
import { installIdeaKeymap } from '../../lib/editor/idea-keymap'
import { installEditorOpener } from '../../lib/editor/navigation'
import { usePanelActions } from '../../lib/actions/action-tree'
import { editorNodes } from '../../lib/actions/editor-actions'
import { minimalEdit } from '../../lib/editor/file-versions'

const COPY_REF_ACTION = 'satura.action.copyFileLineRef'
const WRAP_ACTION = 'satura.action.toggleWordWrap'
const BLAME_ACTION = 'satura.action.toggleGitBlame'
const SAVE_ACTION = 'satura.action.save'
const NO_PALETTE_ACTION = 'satura.action.noCommandPalette'
const GUARD_REJECT_MS = 2600
const MERGE_WARNING_MS = 3200

const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent)

installEditorOpener()
installIdeaKeymap()

const RETAINED_MODELS = 10
const RETAINED_CHARS = 16 * 1024 * 1024
const modelRefs = new Map<Monaco.editor.ITextModel, number>()
const viewStates = new Map<string, Monaco.editor.ICodeEditorViewState>()
censusTrack('MonacoEditor.modelRefs', modelRefs)
const releasedModels: Monaco.editor.ITextModel[] = []

function retainModel(model: Monaco.editor.ITextModel): void {
  modelRefs.set(model, (modelRefs.get(model) ?? 0) + 1)
  const i = releasedModels.indexOf(model)
  if (i >= 0) releasedModels.splice(i, 1)
}

function releaseModel(model: Monaco.editor.ITextModel): void {
  const n = (modelRefs.get(model) ?? 1) - 1
  if (n > 0) {
    modelRefs.set(model, n)
    return
  }
  modelRefs.delete(model)
  if (model.isDisposed()) return
  releasedModels.push(model)
  let chars = 0
  for (const m of releasedModels) chars += m.isDisposed() ? 0 : m.getValueLength()
  let needed: Set<string> | null = null
  let i = 0
  while (
    i < releasedModels.length - 1 &&
    (releasedModels.length > RETAINED_MODELS || chars > RETAINED_CHARS)
  ) {
    const old = releasedModels[i]
    if (old.isDisposed()) {
      releasedModels.splice(i, 1)
      continue
    }
    needed ??= modelsInUse()
    if (modelRefs.has(old) || needed.has(old.uri.toString()) || shownByAnyEditor(old)) {
      i++
      continue
    }
    releasedModels.splice(i, 1)
    chars -= old.getValueLength()
    old.dispose()
  }
}

function modelsInUse(): Set<string> {
  const { viewerFileByTab, draftsByPath } = useAppStore.getState()
  const uris = new Set<string>()
  for (const path of Object.values(viewerFileByTab)) if (path) uris.add(monaco.Uri.parse(path).toString())
  for (const path of Object.keys(draftsByPath)) uris.add(monaco.Uri.parse(path).toString())
  return uris
}

function shownByAnyEditor(model: Monaco.editor.ITextModel): boolean {
  return monaco.editor.getEditors().some((e) => e.getModel() === model)
}

function trackEditorModel(editor: Monaco.editor.IStandaloneCodeEditor): void {
  let held = editor.getModel()
  if (held) retainModel(held)
  editor.onDidChangeModel(() => {
    const next = editor.getModel()
    if (next === held) return
    if (held) releaseModel(held)
    held = next
    if (held) retainModel(held)
  })
  editor.onDidDispose(() => {
    if (held) releaseModel(held)
    held = null
  })
}

function isGotoLineChord(e: KeyboardEvent): boolean {
  const primary = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return primary && !e.altKey && !e.shiftKey && chordKey(e) === 'l'
}

function isWordNavChord(e: KeyboardEvent): boolean {
  const key = chordKey(e)
  if (key !== 'arrowleft' && key !== 'arrowright') return false
  return IS_MAC ? e.altKey && !e.metaKey && !e.ctrlKey : e.ctrlKey && !e.altKey && !e.metaKey
}

function isLineStartEndChord(e: KeyboardEvent): boolean {
  if (!IS_MAC) return false
  const key = chordKey(e)
  if (key !== 'arrowleft' && key !== 'arrowright') return false
  return e.metaKey && !e.ctrlKey && !e.altKey
}

function isSelectLineChord(e: KeyboardEvent): boolean {
  return e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && chordKey(e) === 'arrowup'
}

function isDuplicateLineChord(e: KeyboardEvent): boolean {
  const primary = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return primary && !e.altKey && !e.shiftKey && chordKey(e) === 'd'
}

function isCommentChord(e: KeyboardEvent): boolean {
  const primary = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!primary || e.altKey) return false
  return chordKey(e) === '/' || e.code === 'Slash' || e.code === 'NumpadDivide'
}

function isAllowedChord(e: KeyboardEvent): boolean {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey
  const key = chordKey(e)

  if (isGotoLineChord(e)) return true
  if (isWordNavChord(e)) return true
  if (isLineStartEndChord(e)) return true

  if (!mod || e.altKey) return false

  if (!e.shiftKey) {
    if (key === 's' || key === 'f' || key === 'z' || key === 'p' || key === 'b') return true
    if (key === 'c' || key === 'v' || key === 'x' || key === 'a' || key === 'insert') return true
    if (
      key === '=' ||
      key === '+' ||
      key === '-' ||
      key === '_' ||
      key === '0' ||
      e.code === 'Equal' ||
      e.code === 'NumpadAdd' ||
      e.code === 'Minus' ||
      e.code === 'NumpadSubtract' ||
      e.code === 'Digit0' ||
      e.code === 'Numpad0'
    )
      return true
    return false
  }

  if (e.shiftKey) {
    if (key === 'z' || key === 'f') return true
    return false
  }

  return false
}

export default function MonacoEditor({
  path,
  rootPath,
  value,
  language,
  onChange,
  onSave,
  wrap,
  onToggleWrap,
  fontSize,
  themeId,
  readOnly = false,
  blame = false,
  dirty = false,
  onToggleBlame,
  blameAvailable = false,
  onShowCommit,
  followTail = false,
  onFollowTailChange,
  hotReloadGuard = false,
  highlight,
  actionScope
}: {
  path: string
  rootPath: string
  value: string
  language: string
  onChange: (value: string) => void
  onSave: (value: string) => void
  wrap: boolean
  onToggleWrap: () => void
  fontSize: number
  themeId: ThemeId
  readOnly?: boolean
  blame?: boolean
  dirty?: boolean
  onToggleBlame?: () => void
  blameAvailable?: boolean
  onShowCommit?: (hash: string) => void
  followTail?: boolean
  onFollowTailChange?: (on: boolean) => void
  hotReloadGuard?: boolean
  highlight?: { line: number; endLine?: number }
  actionScope?: string
}) {
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onToggleWrapRef = useRef(onToggleWrap)
  onToggleWrapRef.current = onToggleWrap
  const wrapRef = useRef(wrap)
  wrapRef.current = wrap

  const pathRef = useRef(path)
  pathRef.current = path
  const valueRef = useRef(value)
  valueRef.current = value
  const rootPathRef = useRef(rootPath)
  rootPathRef.current = rootPath
  const onToggleBlameRef = useRef(onToggleBlame)
  onToggleBlameRef.current = onToggleBlame
  const blameAvailableRef = useRef(blameAvailable)
  blameAvailableRef.current = blameAvailable

  type EditorHandle = Parameters<OnMount>[0]
  const editorRef = useRef<EditorHandle | null>(null)
  const followTailRef = useRef(followTail)
  followTailRef.current = followTail
  const onFollowTailChangeRef = useRef(onFollowTailChange)
  onFollowTailChangeRef.current = onFollowTailChange
  const draggingScrollbarRef = useRef(false)
  const [editorInstance, setEditorInstance] = useState<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const [monacoInstance, setMonacoInstance] = useState<typeof Monaco | null>(null)
  const [blameRanges, setBlameRanges] = useState<BlameRange[] | null>(null)
  const [blameStatus, setBlameStatus] = useState<{ kind: 'idle' | 'loading' | 'ready' } | { kind: 'error'; message: string }>({ kind: 'idle' })
  const [gutterMenu, setGutterMenu] = useState<{ x: number; y: number; line: number; range?: BlameRange } | null>(null)
  const [blamePick, setBlamePick] = useState<BlameRange | null>(null)
  usePanelActions(
    actionScope,
    editorInstance
      ? editorNodes(editorInstance, {
          readOnly,
          onSave: () => onSaveRef.current(editorInstance.getValue()),
          onToggleWrap: () => onToggleWrapRef.current(),
          onToggleBlame: onToggleBlame ? () => onToggleBlameRef.current?.() : undefined,
          blameAvailable,
          onCopyReference: () => void editorInstance.getAction(COPY_REF_ACTION)?.run(),
          onFontSize: (d) => useAppStore.getState().adjustFontSize('editor', d)
        })
      : []
  )

  const guardRef = useRef(hotReloadGuard)
  guardRef.current = hotReloadGuard
  const bodyRangesRef = useRef<ReturnType<typeof findHotReloadableRanges>>([])
  const revertingRef = useRef(false)
  const revertScheduledRef = useRef(false)
  const lastGoodValueRef = useRef<string | null>(null)
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null)
  const rejectTimerRef = useRef<number | undefined>(undefined)
  const [rejected, setRejected] = useState(false)
  const [conflictCount, setConflictCount] = useState(0)
  const [mergeWarning, setMergeWarning] = useState<string | null>(null)
  const mergeWarningTimerRef = useRef<number | undefined>(undefined)
  const [compare, setCompare] = useState<MergeConflictCompareRequest | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const changeHandlerRef = useRef<(e: Monaco.editor.IModelContentChangedEvent) => void>(() => {})
  const applyingRef = useRef(false)

  const reveal = (line: number, col: number): void => {
    const ed = editorRef.current
    if (!ed || line < 1) return
    const apply = (): void => {
      const e = editorRef.current
      if (!e) return
      const total = e.getModel()?.getLineCount() ?? 0
      const target = total > 0 ? Math.min(line, total) : line
      e.setPosition({ lineNumber: target, column: Math.max(1, col) })
      e.revealLineInCenter(target, 1)
    }
    apply()
    requestAnimationFrame(() => {
      apply()
      requestAnimationFrame(apply)
    })
    ed.focus()
  }

  const scrollToBottom = (): void => {
    const ed = editorRef.current
    if (!ed) return
    ed.setScrollTop(ed.getScrollHeight())
  }

  const isFollowActive = (): boolean => onFollowTailChangeRef.current !== undefined

  const isAtBottom = (ed: EditorHandle): boolean => {
    const h = ed.getLayoutInfo().height
    return ed.getScrollTop() + h >= ed.getScrollHeight() - 16
  }

  const VIEWPORT_KEYS = new Set([
    'ArrowUp',
    'ArrowDown',
    'PageUp',
    'PageDown',
    'Home',
    'End'
  ])

  const flashRejected = (): void => {
    setRejected(true)
    if (rejectTimerRef.current) clearTimeout(rejectTimerRef.current)
    rejectTimerRef.current = window.setTimeout(() => setRejected(false), GUARD_REJECT_MS)
  }

  const applyGuardDecorations = (): void => {
    const ed = editorRef.current
    const monaco = monacoRef.current
    const coll = decorationsRef.current
    if (!ed || !monaco || !coll) return
    const model = ed.getModel()
    if (!model) return
    if (!guardRef.current) {
      coll.clear()
      return
    }
    const ranges = bodyRangesRef.current
    const lineCount = model.getLineCount()
    const editableLine = new Array<boolean>(lineCount + 1).fill(false)
    for (const r of ranges) {
      const top = Math.max(1, r.start.line)
      const bottom = Math.min(lineCount, r.end.line)
      for (let l = top; l <= bottom; l++) editableLine[l] = true
    }
    const decos: Monaco.editor.IModelDeltaDecoration[] = []
    for (let l = 1; l <= lineCount; l++) {
      if (editableLine[l]) continue
      decos.push({
        range: new monaco.Range(l, 1, l, 1),
        options: { isWholeLine: true, className: 'ss-hr-locked-line' }
      })
    }
    coll.set(decos)
  }

  const recomputeBodyRanges = (): void => {
    const ed = editorRef.current
    if (!ed) return
    const model = ed.getModel()
    if (!model) {
      bodyRangesRef.current = []
      return
    }
    if (!guardRef.current) {
      bodyRangesRef.current = []
      lastGoodValueRef.current = null
      applyGuardDecorations()
      return
    }
    const text = model.getValue()
    bodyRangesRef.current = findHotReloadableRanges(text)
    lastGoodValueRef.current = text
    applyGuardDecorations()
  }

  const scheduleRevert = (): void => {
    if (revertScheduledRef.current) return
    revertScheduledRef.current = true
    queueMicrotask(() => {
      revertScheduledRef.current = false
      const ed = editorRef.current
      const monaco = monacoRef.current
      const good = lastGoodValueRef.current
      if (!ed || !monaco || good == null) return
      const model = ed.getModel()
      if (!model || model.getValue() === good) return
      const sel = ed.getSelection()
      revertingRef.current = true
      try {
        ed.executeEdits('hotReloadGuard', [
          { range: model.getFullModelRange(), text: good, forceMoveMarkers: true }
        ])
        ed.pushUndoStop()
        if (sel) ed.setSelection(sel)
      } finally {
        revertingRef.current = false
      }
      onChange(good)
      applyGuardDecorations()
    })
  }

  const handleModelChange = (e: Monaco.editor.IModelContentChangedEvent): void => {
    if (revertingRef.current) return
    if (!guardRef.current) return
    if (applyingRef.current) {
      recomputeBodyRanges()
      return
    }
    const ranges = bodyRangesRef.current
    const illegal = e.changes.some(
      (c) => !rangeFullyInsideBody(ranges, c.rangeOffset, c.rangeOffset + c.rangeLength)
    )
    if (illegal) {
      scheduleRevert()
      flashRejected()
      return
    }
    recomputeBodyRanges()
  }
  changeHandlerRef.current = handleModelChange

  const handleBeforeMount: BeforeMount = (monaco) => {
    defineMonacoThemes(monaco)
  }

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    const mountModel = editor.getModel()
    if (mountModel && mountModel.getValue() !== valueRef.current) {
      mountModel.pushEditOperations(
        [],
        [{ range: mountModel.getFullModelRange(), text: valueRef.current }],
        () => null
      )
      editor.pushUndoStop()
    }
    trackEditorModel(editor)
    setEditorInstance(editor)
    setMonacoInstance(monaco)
    editor.onDidDispose(registerMonacoEditor(editor))
    const actions = [
      editor.addAction({
        id: SAVE_ACTION,
        label: 'Save',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => {
          onSaveRef.current(editor.getValue())
        }
      }),
      editor.addAction({
        id: NO_PALETTE_ACTION,
        label: 'Command Palette (disabled)',
        keybindings: [monaco.KeyCode.F1],
        run: () => {
          if (IS_MAC) void editor.getAction('editor.action.showHover')?.run()
        }
      })
    ]
    editor.onDidDispose(() => {
      for (const action of actions) action.dispose()
    })
    attachMergeConflicts(editor, monaco, {
      onConflictsCount: setConflictCount,
      onWarning: (message) => {
        setMergeWarning(message)
        if (mergeWarningTimerRef.current) clearTimeout(mergeWarningTimerRef.current)
        mergeWarningTimerRef.current = window.setTimeout(() => setMergeWarning(null), MERGE_WARNING_MS)
      },
      onCompare: setCompare
    })
    const dom = editor.getDomNode()
    if (dom) {
      const blockChords = (be: KeyboardEvent): void => {
        if (isGotoLineChord(be)) {
          be.preventDefault()
          be.stopImmediatePropagation()
          editor.getAction('editor.action.gotoLine')?.run()
          return
        }
        if (isIdeaChord(be)) return
        if (isSelectLineChord(be)) {
          be.preventDefault()
          be.stopImmediatePropagation()
          const model = editor.getModel()
          const sel = editor.getSelection()
          if (model && sel) {
            editor.setSelection(
              new monaco.Selection(
                sel.startLineNumber,
                1,
                sel.endLineNumber,
                model.getLineMaxColumn(sel.endLineNumber)
              )
            )
          }
          return
        }
        if (isDuplicateLineChord(be)) {
          be.preventDefault()
          be.stopImmediatePropagation()
          editor.getAction('editor.action.copyLinesDownAction')?.run()
          return
        }
        if (isCommentChord(be)) {
          be.preventDefault()
          be.stopImmediatePropagation()
          editor.getAction('editor.action.commentLine')?.run()
          return
        }
        const hasMod = be.ctrlKey || be.metaKey || be.altKey
        if (!hasMod) return
        if (isAllowedChord(be)) return
        be.preventDefault()
        be.stopImmediatePropagation()
      }
      dom.addEventListener('keydown', blockChords, true)
      const blockFindTooltips = (me: MouseEvent): void => {
        const t = me.target as HTMLElement | null
        if (!t?.closest('.find-widget')) return
        if (
          t.closest('.monaco-custom-toggle.codicon-find-selection') ||
          t.closest('.button.codicon-widget-close')
        )
          me.stopImmediatePropagation()
      }
      dom.addEventListener('mouseover', blockFindTooltips, true)
      editor.onDidDispose(() => {
        dom.removeEventListener('keydown', blockChords, true)
        dom.removeEventListener('mouseover', blockFindTooltips, true)
      })
    }
    actions.push(editor.addAction({
      id: COPY_REF_ACTION,
      label: 'Copy Reference (path:line)',
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 4,
      run: (ed) => {
        const pos = ed.getPosition()
        if (!pos) return
        void window.api.ui.writeClipboardText(
          `${relativePath(rootPathRef.current, pathRef.current)}:${pos.lineNumber}`
        )
      }
    }))
    actions.push(editor.addAction({
      id: WRAP_ACTION,
      label: 'Toggle Auto Wrap',
      contextMenuGroupId: 'z_view',
      contextMenuOrder: 1,
      run: () => onToggleWrapRef.current()
    }))
    actions.push(editor.addAction({
      id: BLAME_ACTION,
      label: 'Toggle Git Blame',
      contextMenuGroupId: 'z_view',
      contextMenuOrder: 2,
      run: () => {
        if (blameAvailableRef.current) onToggleBlameRef.current?.()
      }
    }))
    editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS || !onToggleBlameRef.current) return
      if (!e.event.leftButton && !e.event.rightButton) return
      const line = e.target.position?.lineNumber ?? 1
      const { posx, posy } = e.event
      requestAnimationFrame(() => setGutterMenu({ x: posx, y: posy, line }))
    })
    try {
      const cm = editor.getContribution('editor.contrib.contextmenu') as unknown as {
        _getMenuActions?: (...args: unknown[]) => Array<{ id?: string; label?: string }>
      } | null
      const orig = cm?._getMenuActions
      if (cm && typeof orig === 'function') {
        const ALLOWED = new Set([
          'editor.action.clipboardCutAction',
          'editor.action.clipboardCopyAction',
          'editor.action.clipboardPasteAction'
        ])
        const SEPARATOR_ID = 'vs.actions.separator'
        cm._getMenuActions = (...args: unknown[]) => {
          const all = orig.apply(cm, args)
          const sep = all.find((a) => a?.id === SEPARATOR_ID)
          const isMergeConflictAction = (id: string): boolean =>
            MERGE_CONFLICT_COMMANDS.some((c) => id.endsWith(`:${c.id}`))
          const kept = all.filter(
            (a) =>
              !!a?.id &&
              (ALLOWED.has(a.id) ||
                a.id.endsWith(COPY_REF_ACTION) ||
                a.id.endsWith(WRAP_ACTION) ||
                (a.id.endsWith(BLAME_ACTION) && !!onToggleBlameRef.current && blameAvailableRef.current) ||
                isMergeConflictAction(a.id))
          )
          const firstMergeItem = kept.findIndex((a) => !!a.id && isMergeConflictAction(a.id))
          if (sep && firstMergeItem > 0) kept.splice(firstMergeItem, 0, sep)
          const wrapItem = kept.find((a) => !!a.id && a.id.endsWith(WRAP_ACTION))
          if (wrapItem) {
            wrapItem.label = wrapRef.current ? 'Auto Wrap: On' : 'Auto Wrap: Off'
            const idx = kept.indexOf(wrapItem)
            if (sep && idx > 0) kept.splice(idx, 0, sep)
          }
          return kept
        }
      }
    } catch {
    }
    editor.onDidScrollChange(() => {
      if (!isFollowActive()) return
      if (followTailRef.current) {
        if (draggingScrollbarRef.current && !isAtBottom(editor)) onFollowTailChangeRef.current?.(false)
        return
      }
      if (isAtBottom(editor)) onFollowTailChangeRef.current?.(true)
    })
    if (dom) {
      const disableIfScrolledAway = (): void => {
        if (!isFollowActive() || !followTailRef.current) return
        requestAnimationFrame(() => {
          if (followTailRef.current && !isAtBottom(editor)) onFollowTailChangeRef.current?.(false)
        })
      }
      const onWheel = (we: WheelEvent): void => {
        if (we.deltaY < 0) disableIfScrolledAway()
      }
      const onKeyDownScroll = (ke: KeyboardEvent): void => {
        if (ke.ctrlKey && (ke.key === 'Home' || ke.key === 'End')) {
          disableIfScrolledAway()
          return
        }
        if (VIEWPORT_KEYS.has(ke.key)) disableIfScrolledAway()
      }
      const onPointerDownScroll = (pe: PointerEvent): void => {
        const target = pe.target as HTMLElement | null
        if (!target?.closest('.scrollbar.vertical')) return
        draggingScrollbarRef.current = true
        const stop = (): void => {
          draggingScrollbarRef.current = false
          window.removeEventListener('pointerup', stop, true)
          window.removeEventListener('pointercancel', stop, true)
        }
        window.addEventListener('pointerup', stop, true)
        window.addEventListener('pointercancel', stop, true)
      }
      dom.addEventListener('wheel', onWheel, { passive: true })
      dom.addEventListener('keydown', onKeyDownScroll, true)
      dom.addEventListener('pointerdown', onPointerDownScroll, true)
      editor.onDidDispose(() => {
        dom.removeEventListener('wheel', onWheel)
        dom.removeEventListener('keydown', onKeyDownScroll, true)
        dom.removeEventListener('pointerdown', onPointerDownScroll, true)
      })
    }
    decorationsRef.current = editor.createDecorationsCollection([])
    editor.onDidChangeModelContent((e) => changeHandlerRef.current(e))
    recomputeBodyRanges()
    const g = consumeGoto(path)
    const saved = viewStates.get(path)
    if (g) reveal(g.line, g.col)
    else if (saved && !followTailRef.current && !highlightRef.current) editor.restoreViewState(saved)
    else if (followTailRef.current) {
      scrollToBottom()
      requestAnimationFrame(() => {
        if (followTailRef.current) scrollToBottom()
      })
    } else editor.focus()
  }

  useEffect(() => {
    const off = subscribeGoto(() => {
      const g = consumeGoto(path)
      if (g) reveal(g.line, g.col)
    })
    return off
  }, [path])

  const highlightRef = useRef(highlight)
  highlightRef.current = highlight
  const hlLine = highlight?.line ?? 0
  const hlEnd = highlight?.endLine ?? 0

  useEffect(() => {
    if (!editorInstance || hlLine < 1) return
    const model = editorInstance.getModel()
    const total = model?.getLineCount() ?? hlLine
    const start = Math.min(hlLine, total)
    const end = Math.min(Math.max(start, hlEnd || start), total)
    const deco = editorInstance.createDecorationsCollection([
      { range: { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: 1 }, options: { isWholeLine: true, className: 'rk-code-hl', linesDecorationsClassName: 'rk-code-hl-gutter' } }
    ])
    editorInstance.setPosition({ lineNumber: start, column: 1 })
    editorInstance.revealLinesInCenter(start, end, 1)
    return () => deco.clear()
  }, [editorInstance, hlLine, hlEnd, value])

  useEffect(() => {
    if (!editorInstance) return
    return () => {
      const vs = editorInstance.saveViewState()
      if (vs) {
        viewStates.delete(path)
        viewStates.set(path, vs)
        while (viewStates.size > 200) viewStates.delete(viewStates.keys().next().value as string)
      }
    }
  }, [editorInstance, path])

  const syncedRef = useRef<{ model: Monaco.editor.ITextModel; version: number; text: string } | null>(
    null
  )

  useLayoutEffect(() => {
    const ed = editorRef.current
    if (readOnly || !ed || !monacoRef.current) return
    const model = ed.getModel()
    if (!model || model.uri.toString() !== monacoRef.current.Uri.parse(path).toString()) return
    const edit = minimalEdit(model.getValue(), value)
    if (!edit) return
    const from = model.getPositionAt(edit.start)
    const to = model.getPositionAt(edit.end)
    applyingRef.current = true
    try {
      ed.pushUndoStop()
      ed.executeEdits('satura.sync', [{ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: edit.text }])
      ed.pushUndoStop()
    } finally {
      applyingRef.current = false
    }
  }, [value, readOnly, path])

  useEffect(() => {
    if (!readOnly || !editorInstance) return
    const model = editorInstance.getModel()
    if (!model) return
    const prev = syncedRef.current
    if (prev && prev.model === model && prev.version === model.getVersionId()) {
      if (prev.text === value) return
      if (value.length > prev.text.length && value.startsWith(prev.text)) {
        const line = model.getLineCount()
        const col = model.getLineMaxColumn(line)
        model.applyEdits([
          {
            range: { startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col },
            text: value.slice(prev.text.length)
          }
        ])
        syncedRef.current = { model, version: model.getVersionId(), text: value }
        return
      }
    }
    if (model.getValue() !== value) model.setValue(value)
    syncedRef.current = { model, version: model.getVersionId(), text: value }
  }, [value, readOnly, editorInstance, path])

  useEffect(() => {
    if (!followTailRef.current) return
    scrollToBottom()
    const raf = requestAnimationFrame(() => {
      if (followTailRef.current) scrollToBottom()
    })
    return () => cancelAnimationFrame(raf)
  }, [value])

  useEffect(() => {
    if (followTail) scrollToBottom()
  }, [followTail, path])

  useEffect(() => {
    if (!blame || dirty) {
      setBlameRanges(null)
      setBlameStatus({ kind: 'idle' })
      return
    }
    let cancelled = false
    const reqPath = path
    setBlameRanges(null)
    setBlameStatus({ kind: 'loading' })
    void window.api.git
      .blame(rootPath, reqPath)
      .then((ranges) => {
        if (cancelled || pathRef.current !== reqPath) return
        setBlameRanges(ranges)
        setBlameStatus(ranges.length > 0 ? { kind: 'ready' } : { kind: 'error', message: 'git blame returned nothing for this file' })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setBlameRanges(null)
        const raw = err instanceof Error ? err.message : String(err)
        setBlameStatus({ kind: 'error', message: raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
      })
    return () => {
      cancelled = true
    }
  }, [blame, dirty, path, rootPath])

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize })
  }, [fontSize])

  useEffect(() => {
    if (!editorInstance || !monacoInstance) return
    recomputeBodyRanges()
  }, [editorInstance, monacoInstance, hotReloadGuard, path, value])

  useEffect(
    () => () => {
      if (rejectTimerRef.current) clearTimeout(rejectTimerRef.current)
      if (mergeWarningTimerRef.current) clearTimeout(mergeWarningTimerRef.current)
    },
    []
  )

  useEffect(() => {
    setCompare(null)
    setGutterMenu(null)
    setBlamePick(null)
  }, [path])

  const runMergeConflictAction = (id: string): void => {
    void editorRef.current?.getAction(id)?.run()
  }

  const large = value.length > 1024 * 1024
  const showBlame =
    blame && !dirty && editorInstance && monacoInstance && blameRanges && blameRanges.length > 0

  return (
    <div className="relative flex h-full w-full">
      {showBlame && (
        <BlameGutter
          editor={editorInstance}
          monaco={monacoInstance}
          ranges={blameRanges}
          fontSize={fontSize}
          onContextMenu={(x, y, line, range) => setGutterMenu({ x, y, line, range })}
          onPick={(range, line) => {
            console.info(`[blame] line ${line}: ${range.uncommitted ? 'not committed' : `${range.hash.slice(0, 7)} by ${range.author}`}`)
            setBlamePick(range)
          }}
          picked={blamePick}
        />
      )}
      {showBlame && blamePick && <BlameSheet range={blamePick} onClose={() => setBlamePick(null)} onShowCommit={onShowCommit} />}
      <div className="relative h-full min-w-0 flex-1">
        {hotReloadGuard && (
          <div className="pointer-events-none absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded border border-amber-400/30 bg-amber-500/15 px-2.5 py-1 text-[11px] text-amber-200 shadow-sm backdrop-blur-sm">
            <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13z" />
            </svg>
            Hot reload — method bodies only
          </div>
        )}
        {conflictCount > 0 && !compare && (
          <div className="absolute right-5 top-1 z-10 flex items-center gap-0.5 rounded-md border border-hairline bg-panel/90 p-px shadow-sm">
            <Tooltip label="Previous Conflict">
              <button
                type="button"
                aria-label="Previous Conflict"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runMergeConflictAction('merge-conflict.previous')}
                className="rounded p-1 text-ink-3 hover:bg-white/10 hover:text-ink"
              >
                <ArrowUp size={14} />
              </button>
            </Tooltip>
            <Tooltip label="Next Conflict">
              <button
                type="button"
                aria-label="Next Conflict"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runMergeConflictAction('merge-conflict.next')}
                className="rounded p-1 text-ink-3 hover:bg-white/10 hover:text-ink"
              >
                <ArrowDown size={14} />
              </button>
            </Tooltip>
          </div>
        )}
        {blame && !dirty && blameStatus.kind === 'loading' && (
          <div className="pointer-events-none absolute right-5 top-1 z-10 flex items-center gap-1.5 rounded border border-hairline bg-panel/90 px-2 py-1 text-[11px] text-ink-2 shadow-sm" data-blame-status="loading">
            <LoaderCircle size={12} className="animate-spin" />
            Loading git blame…
          </div>
        )}
        {blame && !dirty && blameStatus.kind === 'error' && (
          <div className="absolute right-5 top-1 z-10 flex max-w-md items-center gap-1.5 rounded border border-rose-400/30 bg-rose-500/15 px-2 py-1 text-[11px] text-rose-100 shadow-sm" data-blame-status="error">
            <TriangleAlert size={12} className="shrink-0 text-rose-300" />
            <span className="min-w-0 truncate">Git blame failed: {blameStatus.message}</span>
          </div>
        )}
        {blame && dirty && (
          <div className="pointer-events-none absolute right-5 top-1 z-10 rounded border border-hairline bg-panel/90 px-2 py-1 text-[11px] text-ink-3 shadow-sm">
            Blame paused, save the file to see it
          </div>
        )}
        {gutterMenu && (
          <FloatingMenu x={gutterMenu.x} y={gutterMenu.y} onDismiss={() => setGutterMenu(null)}>
            <button
              type="button"
              className={menuItemClass}
              disabled={!blameAvailable || (blame && blameStatus.kind === 'loading')}
              onClick={() => {
                setGutterMenu(null)
                onToggleBlameRef.current?.()
              }}
            >
              {blame && blameStatus.kind === 'loading' ? <LoaderCircle size={14} className="animate-spin" /> : <GitCommitHorizontal size={14} />}
              {blame ? (blameStatus.kind === 'loading' ? 'Loading Git Blame…' : 'Hide Git Blame') : 'Show Git Blame'}
            </button>
            {blame && blameStatus.kind === 'loading' && (
              <button
                type="button"
                className={menuItemClass}
                onClick={() => {
                  setGutterMenu(null)
                  onToggleBlameRef.current?.()
                }}
              >
                Cancel
              </button>
            )}
            {!blameAvailable && (
              <>
                <MenuSeparator />
                <div className="max-w-64 px-3 pb-1.5 pt-0.5 text-xs text-ink-3">This file isn't tracked by Git, so there's nothing to blame.</div>
              </>
            )}
            {blame && blameStatus.kind === 'error' && (
              <>
                <MenuSeparator />
                <div className="max-w-64 px-3 pb-1.5 pt-0.5 text-xs text-rose-200">Git blame failed: {blameStatus.message}</div>
              </>
            )}
            {gutterMenu.range && !gutterMenu.range.uncommitted && (
              <>
                <MenuSeparator />
                <button
                  type="button"
                  className={menuItemClass}
                  onClick={() => {
                    setGutterMenu(null)
                    void window.api.ui.writeClipboardText(gutterMenu.range!.hash)
                  }}
                >
                  Copy Commit Hash
                  <span className="ml-auto pl-4 font-mono text-xs text-ink-3">{gutterMenu.range.hash.slice(0, 7)}</span>
                </button>
                <button
                  type="button"
                  className={menuItemClass}
                  onClick={() => {
                    setGutterMenu(null)
                    void window.api.ui.writeClipboardText(gutterMenu.range!.summary)
                  }}
                >
                  Copy Commit Message
                </button>
                {onShowCommit && (
                  <button
                    type="button"
                    className={menuItemClass}
                    onClick={() => {
                      setGutterMenu(null)
                      onShowCommit(gutterMenu.range!.hash)
                    }}
                  >
                    <GitCommitHorizontal size={14} /> Show in Git
                  </button>
                )}
              </>
            )}
            <MenuSeparator />
            <button
              type="button"
              className={menuItemClass}
              onClick={() => {
                setGutterMenu(null)
                void window.api.ui.writeClipboardText(`${relativePath(rootPathRef.current, pathRef.current)}:${gutterMenu.line}`)
              }}
            >
              Copy Reference (path:{gutterMenu.line})
            </button>
          </FloatingMenu>
        )}
        {mergeWarning && (
          <div className={`pointer-events-none absolute left-1/2 ${hotReloadGuard ? 'top-10' : 'top-2'} z-10 flex max-w-md -translate-x-1/2 items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-500/15 px-3 py-1.5 text-xs text-amber-100 shadow-lg backdrop-blur-sm`}>
            {mergeWarning}
          </div>
        )}
        {hotReloadGuard && rejected && (
          <div className="pointer-events-none absolute left-1/2 top-10 z-10 flex max-w-md -translate-x-1/2 items-center gap-2 rounded-lg border border-rose-400/30 bg-rose-500/15 px-3 py-1.5 text-xs text-rose-100 shadow-lg backdrop-blur-sm">
            Can't hot-reload that — only regular method bodies can change. Coroutines, async methods, fields, signatures and types need a stop.
          </div>
        )}
        <Editor
          height="100%"
          path={path}
          language={language}
          value={readOnly ? undefined : value}
          defaultValue={value}
          theme={monacoThemeName(themeId)}
          beforeMount={handleBeforeMount}
          onChange={(v) => {
            if (!applyingRef.current) onChange(v ?? '')
          }}
          onMount={handleMount}
          keepCurrentModel
          options={{
            readOnly,
            domReadOnly: readOnly,
            minimap: { enabled: false },
            fontSize,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
            lineNumbers: 'on',
            renderLineHighlight: large ? 'none' : 'line',
            scrollBeyondLastLine: false,
            wordWrap: large || blame ? 'off' : wrap ? 'on' : 'off',
            tabSize: 2,
            smoothScrolling: true,
            automaticLayout: true,
            padding: { top: 6 },
            scrollbar: { useShadows: false },
            unicodeHighlight: NO_UNICODE_HIGHLIGHT
          }}
        />
        {compare && <MergeConflictCompare request={compare} fontSize={fontSize} onClose={() => setCompare(null)} />}
      </div>
    </div>
  )
}
