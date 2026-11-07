import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, Ellipsis, FileInput } from 'lucide-react'
import type * as Monaco from 'monaco-editor'
import type { ScmConflictSides } from '@shared/git-scm'
import { DisposableStore } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
import { NO_UNICODE_HIGHLIGHT, monaco } from '../../../lib/editor/monaco-setup'
import { chordKey } from '../../../lib/shortcuts/chord-key'
import { defineMonacoThemes, monacoThemeName } from '../../../lib/editor/monaco-themes'
import { activeThemeId } from '../../../lib/theme/themes'
import { requestConfirm } from '../../../lib/confirm/confirm-store'
import { autorun } from '../../../lib/git/merge/core/observable'
import {
  MergeEditorLoadError,
  createWorkspaceMergeEditorInputModel,
  deleteMergeEditorSession,
  getMergeEditorSession,
  loadMergeEditorSources,
  sameInputs,
  sameSources,
  setMergeEditorSession,
  type WorkspaceMergeEditorInputModel
} from '../../../lib/git/merge/mergeEditorInputModel'
import { Tooltip } from '../../ui/Tooltip'
import { FloatingMenu, MenuSeparator, menuItemClass } from '../../ui/FloatingMenu'
import { gitScmApi } from '../use-scm-repository'
import { isMac } from '../use-list-selection'
import { MergeEditor, type IMergeEditorLayout, type IMergeEditorViewState } from './mergeEditor'

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

const patchedMenus = new WeakSet<Monaco.editor.ICodeEditor>()

function dropPaletteFromMenu(editor: Monaco.editor.ICodeEditor): void {
  if (patchedMenus.has(editor)) return
  const menu = editor.getContribution('editor.contrib.contextmenu') as unknown as {
    _getMenuActions?: (...args: unknown[]) => Array<{ id?: string }>
  } | null
  const orig = menu?._getMenuActions
  if (!menu || typeof orig !== 'function') return
  menu._getMenuActions = (...args: unknown[]) => withoutPalette(orig.apply(menu, args))
  patchedMenus.add(editor)
}

function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.substring(i + 1)
}

const EDITOR_OPTIONS: Monaco.editor.IEditorOptions = {
  fontSize: 13,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
  scrollBeyondLastLine: false,
  scrollbar: { useShadows: false },
  unicodeHighlight: NO_UNICODE_HIGHLIGHT
}

function HeaderButton({
  label,
  onClick,
  disabled,
  children
}: {
  label: string
  onClick: (e: React.MouseEvent) => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="rounded p-1 text-ink-3 hover:bg-white/10 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
      >
        {children}
      </button>
    </Tooltip>
  )
}

function MenuCheck({ checked }: { checked: boolean }) {
  return <span className="flex w-4 shrink-0 justify-center">{checked && <Check size={13} />}</span>
}

export function ScmMergeEditor({
  root,
  path,
  rebasing,
  sides,
  version,
  onOpenFile,
  onCompleted
}: {
  root: string
  path: string
  rebasing: boolean
  sides?: ScmConflictSides
  version: number
  onOpenFile?: (path: string) => void
  onCompleted?: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const outerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<MergeEditor | null>(null)
  const pathRef = useRef(path)
  pathRef.current = path
  const sidesRef = useRef(sides)
  sidesRef.current = sides
  const sidesKey = sides ? [sides.kind, sides.current, sides.incoming].join('|') : ''
  const sessionRef = useRef<WorkspaceMergeEditorInputModel | null>(null)
  const [session, setSession] = useState<WorkspaceMergeEditorInputModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [unhandled, setUnhandled] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [layout, setLayout] = useState<IMergeEditorLayout | null>(null)
  const [showNonConflicting, setShowNonConflicting] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const busyRef = useRef(false)
  const theme = monacoThemeName(activeThemeId())

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    defineMonacoThemes(monaco)
    const editor = new MergeEditor(host, () => pathRef.current, EDITOR_OPTIONS)
    editorRef.current = editor
    const store = new DisposableStore()
    store.add(autorun((reader) => {
      const value = editor.layoutMode.read(reader)
      setLayout(value)
      for (const e of editor.editors) dropPaletteFromMenu(e)
    }))
    store.add(autorun((reader) => {
      setShowNonConflicting(editor.showNonConflictingChangesValue.read(reader))
    }))
    const resize = (): void => editor.layout(host.clientWidth, host.clientHeight)
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()
    return () => {
      observer.disconnect()
      store.dispose()
      editorRef.current = null
      editor.dispose()
    }
  }, [])

  useEffect(() => {
    monaco.editor.setTheme(theme)
  }, [theme])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const api = gitScmApi()
    let cancelled = false
    let applied: WorkspaceMergeEditorInputModel | null = null
    let appliedPromise: Promise<WorkspaceMergeEditorInputModel> | null = null
    const store = new DisposableStore()
    setError(null)
    setActionError(null)

    const writeResult = async (content: string): Promise<void> => {
      const result = await api.writeFile(root, path, content)
      if (!result.ok) throw new Error(result.error.message)
    }

    const open = async (): Promise<void> => {
      let pending = getMergeEditorSession(root, path)
      const sources = await loadMergeEditorSources(api, root, path, rebasing, sidesRef.current)
      if (cancelled) return
      if (pending) {
        const existing = await pending.catch(() => undefined)
        if (cancelled) return
        const usable = !!existing && (existing.isDirty.get() ? sameInputs(sources, existing.sources) : sameSources(sources, existing.sources))
        if (!usable) {
          deleteMergeEditorSession(root, path, pending)
          if (existing && !existing.inUse) existing.dispose()
          pending = undefined
        }
      }
      if (!pending) {
        pending = setMergeEditorSession(root, path, createWorkspaceMergeEditorInputModel(sources, path, writeResult))
      }
      const session = await pending
      if (cancelled) return
      session.acquire()
      applied = session
      appliedPromise = pending
      sessionRef.current = session
      editor.setInput(session.model, session.viewState as IMergeEditorViewState | undefined)
      for (const e of editor.editors) dropPaletteFromMenu(e)
      store.add(autorun((reader) => {
        setUnhandled(session.model.unhandledConflictsCount.read(reader))
      }))
      store.add(autorun((reader) => {
        setDirty(session.isDirty.read(reader))
      }))
      setSession(session)
    }

    open().catch((e: unknown) => {
      if (cancelled) return
      setError(e instanceof MergeEditorLoadError || e instanceof Error ? e.message : String(e))
    })

    return () => {
      cancelled = true
      store.dispose()
      if (applied) {
        applied.viewState = editor.computeEditorViewState()
        editor.clearInput()
        const users = applied.release()
        const cached = getMergeEditorSession(root, path) === appliedPromise
        if (users === 0 && (!cached || !applied.isDirty.get())) {
          if (appliedPromise) deleteMergeEditorSession(root, path, appliedPromise)
          applied.dispose()
        }
      }
      sessionRef.current = null
      setSession(null)
    }
  }, [root, path, rebasing, sidesKey, reloadToken])

  const firstVersion = useRef(version)
  useEffect(() => {
    if (version === firstVersion.current) return
    const current = sessionRef.current
    if (!current || current.isDirty.get()) return
    let cancelled = false
    void loadMergeEditorSources(gitScmApi(), root, path, rebasing, sidesRef.current).then(
      (sources) => {
        if (cancelled || sessionRef.current !== current || current.isDirty.get()) return
        if (!sameSources(sources, current.sources)) setReloadToken((t) => t + 1)
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [version, root, path, rebasing, sidesKey])

  const save = useCallback(async (): Promise<boolean> => {
    const current = sessionRef.current
    if (!current) return false
    try {
      await current.save()
      setActionError(null)
      return true
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
      return false
    }
  }, [])

  const completeMerge = useCallback(async (): Promise<void> => {
    const current = sessionRef.current
    if (!current || busyRef.current) return
    busyRef.current = true
    try {
      if (current.model.unhandledConflictsCount.get() > 0) {
        const confirmed = await requestConfirm({
          title: `Do you want to complete the merge of ${basename(path)}?`,
          message: 'The file contains unhandled conflicts.',
          confirmLabel: 'Complete with Conflicts',
          danger: false
        })
        if (!confirmed) return
      }
      if (sessionRef.current !== current) return
      await current.accept()
      const result = await gitScmApi().add(root, [path])
      if (!result.ok) throw new Error(result.error.message)
      setActionError(null)
      const pending = getMergeEditorSession(root, path)
      if (pending) deleteMergeEditorSession(root, path, pending)
      onCompleted?.()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      busyRef.current = false
    }
  }, [root, path, onCompleted])

  const completeRef = useRef(completeMerge)
  completeRef.current = completeMerge

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !session) return
    const resultEditor = editor.resultEditor
    const domNode = document.createElement('div')
    domNode.className = 'floating-click-widget'
    domNode.style.padding = '6px 11px'
    domNode.style.borderRadius = 'var(--radius-control)'
    domNode.style.cursor = 'pointer'
    domNode.style.zIndex = '1'
    domNode.style.backgroundColor = 'var(--vscode-button-background, var(--vscode-editor-background))'
    domNode.style.color = 'var(--vscode-button-foreground, var(--vscode-editor-foreground))'
    domNode.style.border = '1px solid var(--vscode-contrastBorder, transparent)'
    domNode.appendChild(document.createElement('span')).textContent = 'Complete Merge'
    domNode.addEventListener('click', () => void completeRef.current())
    const widget: Monaco.editor.IOverlayWidget = {
      getId: () => 'editor.overlayWidget.floatingClickWidget',
      getDomNode: () => domNode,
      getPosition: () => ({ preference: monaco.editor.OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER })
    }
    resultEditor.addOverlayWidget(widget)
    return () => {
      resultEditor.removeOverlayWidget(widget)
    }
  }, [session])

  useEffect(() => {
    const outer = outerRef.current
    if (!outer) return
    const onKey = (e: KeyboardEvent): void => {
      if (isPaletteChord(e)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (!mod || e.altKey) return
      const key = chordKey(e)
      if (key === 's' && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        void save()
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        void completeRef.current()
      } else if (key === 't' && e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        editorRef.current?.toggleBetweenInputs()
      }
    }
    outer.addEventListener('keydown', onKey, true)
    return () => outer.removeEventListener('keydown', onKey, true)
  }, [save])

  const goTo = (next: boolean): void => {
    const vm = editorRef.current?.viewModel.get()
    if (!vm) return
    if (next) vm.goToNextModifiedBaseRange((r) => !vm.model.isHandled(r).get())
    else vm.goToPreviousModifiedBaseRange((r) => !vm.model.isHandled(r).get())
  }

  const act = (fn: () => void) => (): void => {
    fn()
    setMenu(null)
  }

  const editor = editorRef.current
  const title = `Merging: ${basename(path)}`

  return (
    <div ref={outerRef} className="flex h-full min-h-0 flex-col" data-scm-merge-editor={path}>
      <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-hairline bg-canvas px-3 text-[13px]">
        <span className="truncate text-ink">
          {title}
          {dirty && <span className="ml-1.5 text-ink-3">●</span>}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-3">{path}</span>
        {session && (
          <div className="flex shrink-0 items-center gap-0.5">
            {onOpenFile && (
              <HeaderButton label="Open File" onClick={() => onOpenFile(path)}>
                <FileInput size={14} />
              </HeaderButton>
            )}
            <HeaderButton label="Go to Previous Unhandled Conflict" disabled={unhandled === 0} onClick={() => goTo(false)}>
              <ArrowUp size={14} />
            </HeaderButton>
            <HeaderButton label="Go to Next Unhandled Conflict" disabled={unhandled === 0} onClick={() => goTo(true)}>
              <ArrowDown size={14} />
            </HeaderButton>
            <HeaderButton label="More Actions..." onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}>
              <Ellipsis size={14} />
            </HeaderButton>
          </div>
        )}
        {menu && editor && layout && (
          <FloatingMenu x={menu.x} y={menu.y} onDismiss={() => setMenu(null)} className="whitespace-nowrap">
            <button className={menuItemClass} onClick={act(() => editor.setLayoutKind('mixed'))}>
              <MenuCheck checked={layout.kind === 'mixed'} /> Mixed Layout
            </button>
            <button className={menuItemClass} onClick={act(() => editor.setLayoutKind('columns'))}>
              <MenuCheck checked={layout.kind === 'columns'} /> Column Layout
            </button>
            <MenuSeparator />
            {layout.kind === 'columns' ? (
              <button className={menuItemClass} onClick={act(() => editor.toggleBase())}>
                <MenuCheck checked={layout.showBase} /> Show Base
              </button>
            ) : (
              <>
                <button className={menuItemClass} onClick={act(() => editor.toggleShowBaseTop())}>
                  <MenuCheck checked={layout.showBase && layout.showBaseAtTop} /> Show Base Top
                </button>
                <button className={menuItemClass} onClick={act(() => editor.toggleShowBaseCenter())}>
                  <MenuCheck checked={layout.showBase && !layout.showBaseAtTop} /> Show Base Center
                </button>
              </>
            )}
            <MenuSeparator />
            <button className={menuItemClass} onClick={act(() => editor.toggleShowNonConflictingChanges())}>
              <MenuCheck checked={showNonConflicting} /> Show Non-Conflicting Changes
            </button>
          </FloatingMenu>
        )}
      </div>
      {actionError && (
        <div className="shrink-0 border-b border-rose-400/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-200">{actionError}</div>
      )}
      <div className="relative min-h-0 flex-1 bg-editor-surface">
        <div className="monaco-workbench monaco-component absolute inset-0" style={session ? undefined : { visibility: 'hidden' }}>
          <div ref={hostRef} className="h-full w-full" />
        </div>
        {error && <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-ink-3">{error}</div>}
      </div>
    </div>
  )
}
