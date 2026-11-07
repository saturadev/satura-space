import { useViewerZoom } from '../../lib/mobile/viewer-zoom'
import { isMobileLayout } from '../../lib/mobile/mobile-back'
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { DEFAULT_EDITOR_FONT_SIZE, DEFAULT_THEME } from '@shared/types'
import { isPlayableAudio, isPlayableVideo, mediaUrlForPath } from '@shared/media-url'
import { mediaLoader } from '../../lib/media-loader'
import { isHtmlPage, reportUrlForPath } from '@shared/report-url'
import { isReactReport } from '@shared/report-compile'
import { exportFileName } from '@shared/report-export'
import type { ReportLocation } from '@shared/report-link'
import { useAppStore } from '../../store'
import { pathBasename } from '../../lib/path'
import { languageFromPath } from '../../lib/editor/language-from-path'
import { ensureProject, useProjectHotReloadArmed } from '../../lib/unity/world-store'
import { isHotReloadGuardableFile } from '../../lib/unity/hot-reload-guard'
import { relativePath } from '../../lib/file-explorer/copy-paths'
import { openGitCommitFromTab } from '../../lib/git/open-git-history'
import { FloatingMenu, menuItemClass } from '../ui/FloatingMenu'
import { ImagePanZoom } from './ImagePanZoom'
import { ReportPanel } from '../report/ReportPanel'
import { holdReportLocation, takeReportLocation } from '../report/report-view-state'
import { FramePlayer } from '../report/FramePlayer'
import { openFileInWorkbench } from '../../lib/editor/open-file'
import { registerViewerFind } from '../../lib/shortcuts/pane-actions'
import { FindInViewBar } from './FindInViewBar'
import { PaneErrorBoundary } from './PaneErrorBoundary'
import { exportReportHtml } from '../report/export-collect'
import { pickPath } from '../../lib/file-picker/file-picker-store'
import { compact, section, usePanelActions, type ActionNode } from '../../lib/actions/action-tree'
import { hasDiskConflict, versionNames, versionStamp } from '../../lib/editor/file-versions'
import {
  closeCompare,
  conflictFor,
  keepMine,
  noteSavedOnMac,
  openVersions,
  remoteFileSink,
  reportDiskConflict,
  showCompare,
  takeOther,
  thisDevice,
  useFileVersions
} from '../../lib/editor/file-versions-store'
import { TriangleAlert } from 'lucide-react'

const MonacoEditor = lazy(() => import('./MonacoEditor'))
const FileVersionsCompare = lazy(() => import('./FileVersionsCompare'))
const MarkdownView = lazy(() => import('./MarkdownView'))

type Loaded =
  | { path: string; kind: 'loading' }
  | { path: string; kind: 'text'; disk: string }
  | { path: string; kind: 'image'; dataUrl: string }
  | { path: string; kind: 'video'; url: string }
  | { path: string; kind: 'audio'; url: string }
  | { path: string; kind: 'binary' }
  | { path: string; kind: 'tooLarge'; bytes: number }
  | { path: string; kind: 'notFound' }
  | { path: string; kind: 'error'; message: string }

function isLogFile(file: string): boolean {
  const p = file.replace(/\\/g, '/')
  return p.includes('/.sspace/') && p.endsWith('.log')
}

export function PaneFileViewerSlot({
  rootPath,
  tabId,
  focused = false
}: {
  rootPath: string
  tabId: string
  focused?: boolean
}) {
  const selectedFile = useAppStore((s) => s.viewerFileByTab[tabId])
  const draft = useAppStore((s) => (selectedFile ? s.draftsByPath[selectedFile] : undefined))
  const draftMeta = useAppStore((s) => (selectedFile ? s.draftMetaByPath[selectedFile] : undefined))
  const pushConflict = useFileVersions((s) => (selectedFile ? s.push[selectedFile] : undefined))
  const comparing = useFileVersions((s) => s.compare?.tabId === tabId && s.compare.file === selectedFile)
  const setDraft = useAppStore((s) => s.setDraft)
  const promoteTab = useAppStore((s) => s.promoteTab)
  const markdownView = useAppStore((s) => s.markdownViewByTab[tabId]) ?? 'preview'
  const setMarkdownView = useAppStore((s) => s.setMarkdownView)
  const editorWordWrap = useAppStore((s) => s.editorWordWrap)
  const toggleEditorWordWrap = useAppStore((s) => s.toggleEditorWordWrap)
  const pinchZoom = useViewerZoom()
  const editorFontSize = Math.round(useAppStore((s) => s.settings?.editorFontSize ?? DEFAULT_EDITOR_FONT_SIZE) * pinchZoom)
  const themeId = useAppStore((s) => s.settings?.theme ?? DEFAULT_THEME)
  const blameEnabled = useAppStore((s) => (selectedFile ? !!s.blameEnabledByPath[selectedFile] : false))
  const toggleBlame = useAppStore((s) => s.toggleBlame)
  const noteViewerFocus = useAppStore((s) => s.noteViewerFocus)
  const live = useAppStore((s) => !!s.liveByTab[tabId])
  const setViewerLive = useAppStore((s) => s.setViewerLive)
  const logAutoFollow = useAppStore((s) => s.logAutoFollowByTab[tabId] ?? true)
  const setLogAutoFollow = useAppStore((s) => s.setLogAutoFollow)
  const isLog = !!selectedFile && isLogFile(selectedFile)
  const workspaceVisible = useAppStore((s) => {
    const ws = s.activeWorkspaceId
    return !!ws && (s.tabsByWorkspace[ws] ?? []).some((t) => t.id === tabId)
  })
  const workspaceVisibleRef = useRef(workspaceVisible)
  workspaceVisibleRef.current = workspaceVisible
  const tailKickRef = useRef<(() => void) | null>(null)

  const hotReloadArmed = useProjectHotReloadArmed(rootPath)
  const [isUnityProject, setIsUnityProject] = useState(false)

  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [tracked, setTracked] = useState(true)
  const [copiedRel, setCopiedRel] = useState(false)
  const [pathMenu, setPathMenu] = useState<{ x: number; y: number } | null>(null)
  const [reportReloads, setReportReloads] = useState(0)
  const [reportTitle, setReportTitle] = useState('')
  const [find, setFind] = useState<{ seq: number } | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const noteReportTitles = useAppStore((s) => s.noteReportTitles)
  const reportLocRef = useRef<{ path: string; loc: ReportLocation | null }>({ path: '', loc: null })
  const reqIdRef = useRef(0)
  const loadedRef = useRef(loaded)
  loadedRef.current = loaded
  const askAfterSaveRef = useRef<string | null>(null)

  useEffect(() => {
    setReportTitle('')
    if (!selectedFile) {
      setLoaded(null)
      return
    }
    const reqId = ++reqIdRef.current
    if (isPlayableVideo(selectedFile) || isPlayableAudio(selectedFile)) {
      const mediaKind = isPlayableAudio(selectedFile) ? 'audio' : 'video'
      setLoaded({ path: selectedFile, kind: 'loading' })
      const loader = mediaLoader()
      const release = loader?.acquire(selectedFile)
      void window.api.fs.statPath(selectedFile).then(async (info) => {
        if (reqId !== reqIdRef.current) return
        if (!info.exists) return setLoaded({ path: selectedFile, kind: 'notFound' })
        const url = loader ? (loader.stream?.(selectedFile) ?? (await loader.load(selectedFile))) : mediaUrlForPath(selectedFile, info.size)
        if (reqId === reqIdRef.current) setLoaded({ path: selectedFile, kind: mediaKind, url })
      }).catch((err: unknown) => {
        if (reqId === reqIdRef.current) setLoaded({ path: selectedFile, kind: 'error', message: err instanceof Error ? err.message : String(err) })
      })
      return release
    }
    setLoaded({ path: selectedFile, kind: 'loading' })
    void window.api.fs
      .readFile(selectedFile)
      .then((res) => {
        if (reqId !== reqIdRef.current) return
        if (res.notFound) {
          setLoaded({ path: selectedFile, kind: 'notFound' })
        } else if (res.isImage && res.dataUrl) {
          setLoaded({ path: selectedFile, kind: 'image', dataUrl: res.dataUrl })
        } else if (res.tooLarge) {
          setLoaded({ path: selectedFile, kind: 'tooLarge', bytes: res.byteLength ?? 0 })
        } else if (res.isBinary) {
          setLoaded({ path: selectedFile, kind: 'binary' })
        } else {
          setLoaded({ path: selectedFile, kind: 'text', disk: res.content })
        }
      })
      .catch((err: unknown) => {
        if (reqId !== reqIdRef.current) return
        setLoaded({
          path: selectedFile,
          kind: 'error',
          message: err instanceof Error ? err.message : String(err)
        })
      })
  }, [selectedFile])

  const reloadFromDisk = useCallback((): void => {
      const file = useAppStore.getState().viewerFileByTab[tabId]
      if (!file) return
      const reqId = ++reqIdRef.current
      if (isPlayableVideo(file) || isPlayableAudio(file)) {
        const mediaKind = isPlayableAudio(file) ? 'audio' : 'video'
        void window.api.fs.statPath(file).then((info) => {
          if (reqId !== reqIdRef.current) return
          if (!info.exists) {
            setLoaded({ path: file, kind: 'notFound' })
            return
          }
          const prev = loadedRef.current
          if (mediaLoader() && prev?.path === file) return
          const url = mediaUrlForPath(file, info.size)
          if ((prev?.kind === 'video' || prev?.kind === 'audio') && prev.path === file && prev.url === url) return
          setLoaded({ path: file, kind: mediaKind, url })
        }, () => {})
        return
      }
      void window.api.fs.readFile(file).then((res) => {
        if (reqId !== reqIdRef.current) return
        if (res.notFound) {
          const cur = loadedRef.current
          if (cur?.kind !== 'text' && !(cur?.kind === 'notFound' && cur.path === file)) {
            setLoaded({ path: file, kind: 'notFound' })
          }
          return
        }
        const prev = loadedRef.current
        const samePath = prev?.path === file
        if (res.isImage && res.dataUrl) {
          if (!(samePath && prev.kind === 'image' && prev.dataUrl === res.dataUrl)) {
            setLoaded({ path: file, kind: 'image', dataUrl: res.dataUrl })
          }
          return
        }
        if (res.tooLarge) {
          const bytes = res.byteLength ?? 0
          if (!(samePath && prev.kind === 'tooLarge' && prev.bytes === bytes)) {
            setLoaded({ path: file, kind: 'tooLarge', bytes })
          }
          return
        }
        if (res.isBinary) {
          if (!(samePath && prev.kind === 'binary')) setLoaded({ path: file, kind: 'binary' })
          return
        }
        const diskNew = res.content
        if (prev?.kind !== 'text' || prev.path !== file) {
          setLoaded({ path: file, kind: 'text', disk: diskNew })
          return
        }
        if (diskNew === prev.disk) return
        const st = useAppStore.getState()
        const draftNow = st.draftsByPath[file]
        if (draftNow !== undefined && diskNew === draftNow) {
          setLoaded({ path: file, kind: 'text', disk: diskNew })
          setDraft(file, null)
          return
        }
        if (draftNow !== undefined && !st.draftMetaByPath[file] && !remoteFileSink()) st.setDraftMeta(file, { base: versionStamp(prev.disk), by: 'mac' })
        setLoaded({ path: file, kind: 'text', disk: diskNew })
      })
      .catch(() => {})
  }, [tabId, setDraft])

  useEffect(() => {
    window.addEventListener('focus', reloadFromDisk)
    return () => window.removeEventListener('focus', reloadFromDisk)
  }, [reloadFromDisk])

  const prevFocusedRef = useRef(focused)
  useEffect(() => {
    const wasFocused = prevFocusedRef.current
    prevFocusedRef.current = focused
    if (focused && !wasFocused) reloadFromDisk()
  }, [focused, reloadFromDisk])

  useEffect(() => {
    if (isLog && selectedFile) console.info(`[viewer] Live ${live ? 'on' : 'off'} for ${selectedFile} in ${tabId}`)
  }, [isLog, selectedFile, live, tabId])

  useEffect(() => {
    if (!isLog || !selectedFile || !live) return
    const file = selectedFile
    let cancelled = false
    let inFlight = false
    let offset = 0
    let sig: string | undefined
    let text: string | null = null
    const tick = (): void => {
      if (inFlight || document.hidden || !workspaceVisibleRef.current) return
      inFlight = true
      void window.api.fs
        .readFileFrom(file, offset, sig)
        .then((res) => {
          if (cancelled || useAppStore.getState().viewerFileByTab[tabId] !== file) return
          if (res.notFound) {
            offset = 0
            sig = undefined
            text = null
            setLoaded((prev) =>
              prev?.kind === 'text' && prev.path === file ? prev : { path: file, kind: 'notFound' }
            )
            return
          }
          if (res.tooLarge) {
            offset = 0
            sig = undefined
            text = null
            setLoaded((prev) =>
              prev?.kind === 'tooLarge' && prev.path === file && prev.bytes === res.size
                ? prev
                : { path: file, kind: 'tooLarge', bytes: res.size }
            )
            return
          }
          if (res.isBinary) return
          const base = res.reset || text === null ? '' : text
          const next = res.text ? base + res.text : base
          offset = res.next
          sig = res.sig
          if (next === text) return
          text = next
          setLoaded((prev) =>
            prev?.kind === 'text' && prev.path === file && prev.disk === next
              ? prev
              : { path: file, kind: 'text', disk: next }
          )
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false
        })
    }
    tailKickRef.current = tick
    tick()
    const t = window.setInterval(tick, 1000)
    const onVisibility = (): void => {
      if (!document.hidden) tick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      if (tailKickRef.current === tick) tailKickRef.current = null
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [isLog, selectedFile, live, tabId])

  useEffect(() => {
    if (workspaceVisible) tailKickRef.current?.()
  }, [workspaceVisible])

  useEffect(() => {
    if (isLog || loaded?.kind !== 'error') return
    const t = window.setInterval(reloadFromDisk, 1000)
    return () => window.clearInterval(t)
  }, [loaded, isLog, reloadFromDisk])

  useEffect(() => {
    if (!selectedFile || isLog) return
    return window.api.fs.watchFile(selectedFile, reloadFromDisk)
  }, [selectedFile, isLog, reloadFromDisk])

  useEffect(() => {
    if (!selectedFile || isLog) {
      setTracked(false)
      return
    }
    let cancelled = false
    setTracked(true)
    void window.api.git
      .isTracked(rootPath, selectedFile)
      .then((ok) => {
        if (cancelled) return
        setTracked(ok)
        if (!ok && !isMobileLayout() && useAppStore.getState().blameEnabledByPath[selectedFile]) toggleBlame(selectedFile)
      })
      .catch(() => {
        if (!cancelled) setTracked(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedFile, isLog, rootPath, toggleBlame])

  useEffect(() => {
    if (selectedFile) noteViewerFocus(selectedFile)
  }, [selectedFile, noteViewerFocus])

  useEffect(() => {
    if (!rootPath) {
      setIsUnityProject(false)
      return
    }
    let alive = true
    void window.api.unity.isProject(rootPath).then((ok) => {
      if (!alive) return
      setIsUnityProject(ok)
      if (ok) ensureProject(rootPath)
    })
    return () => {
      alive = false
    }
  }, [rootPath])

  const isText = loaded?.kind === 'text' && loaded.path === selectedFile
  const disk = isText ? (loaded as { disk: string }).disk : ''
  const dirty = draft !== undefined
  const value = draft ?? disk
  const diskStamp = isText ? versionStamp(disk) : ''
  const twoOnDisk = isText && !isLog && hasDiskConflict(draft, disk, draftMeta)
  const twoVersions = twoOnDisk || (isText && !!pushConflict)
  const metaBase = draftMeta?.base
  const metaBy = draftMeta?.by

  useEffect(() => {
    if (!selectedFile || !isText || isLog || !dirty || draftMeta || remoteFileSink()) return
    useAppStore.getState().setDraftMeta(selectedFile, { base: diskStamp, by: 'mac' })
  }, [selectedFile, isText, isLog, dirty, draftMeta, diskStamp])

  useEffect(() => {
    if (!selectedFile || !twoOnDisk || !metaBase || !metaBy) return
    const file = selectedFile
    reportDiskConflict(tabId, file, {
      file,
      kind: 'disk',
      from: 'disk',
      by: metaBy,
      key: `disk:${file}:${metaBase}:${diskStamp}`,
      auto: metaBy === thisDevice(),
      tabId,
      diskStamp
    })
    if (askAfterSaveRef.current === file) {
      askAfterSaveRef.current = null
      openVersions(file)
    }
    return () => reportDiskConflict(tabId, file, null)
  }, [selectedFile, tabId, twoOnDisk, metaBase, metaBy, diskStamp])
  const isMarkdown = !!selectedFile && languageFromPath(selectedFile) === 'markdown'
  const showPreview = isText && isMarkdown && markdownView === 'preview'
  const isReport = !!selectedFile && isReactReport(selectedFile)
  const isPage = !!selectedFile && isHtmlPage(selectedFile)
  const showReport = isText && isReport && markdownView === 'preview'
  const showPage = isText && isPage && markdownView === 'preview'
  const rendered = showPreview || showReport || showPage
  const findable = showPreview || showReport
  useEffect(() => {
    if (!findable) {
      setFind(null)
      return
    }
    return registerViewerFind(tabId, () => setFind((f) => ({ seq: (f?.seq ?? 0) + 1 })))
  }, [findable, tabId])
  const isVideo = loaded?.kind === 'video' && loaded.path === selectedFile
  const blameActive = blameEnabled && tracked
  const hotReloadGuard =
    hotReloadArmed &&
    isUnityProject &&
    !!selectedFile &&
    isHotReloadGuardableFile(rootPath, selectedFile)

  const onChange = useCallback(
    (next: string) => {
      if (!selectedFile || isLog) return
      const cur = loadedRef.current
      const diskNow = cur?.kind === 'text' && cur.path === selectedFile ? cur.disk : disk
      const st = useAppStore.getState()
      const prev = st.draftsByPath[selectedFile] ?? diskNow
      if (next === prev) return
      const local = next === diskNow ? null : next
      const remote = remoteFileSink()
      if (remote) {
        setDraft(selectedFile, local)
        remote.edit(selectedFile, prev, next, local)
      } else {
        const meta = st.draftMetaByPath[selectedFile]
        setDraft(selectedFile, local, local === null ? undefined : { base: meta?.base ?? versionStamp(diskNow), by: 'mac' })
      }
      promoteTab(tabId)
    },
    [selectedFile, isLog, disk, setDraft, promoteTab, tabId]
  )

  const save = useCallback(
    (next: string) => {
      if (!selectedFile || isLog) return
      const file = selectedFile
      if (conflictFor(file)) {
        openVersions(file)
        return
      }
      const saved = (): void => {
        setLoaded((prev) => (prev && prev.path === file && prev.kind === 'text' ? { ...prev, disk: next } : prev))
        const st = useAppStore.getState()
        const now = st.draftsByPath[file]
        if (now === undefined || now === next) setDraft(file, null)
        else st.setDraftMeta(file, { base: versionStamp(next), by: st.draftMetaByPath[file]?.by ?? thisDevice() })
      }
      const remote = remoteFileSink()
      if (remote) {
        void remote.save(file, next).then((ok) => ok && saved())
        return
      }
      const st = useAppStore.getState()
      const cur = loadedRef.current
      const shown = cur?.kind === 'text' && cur.path === file ? cur.disk : undefined
      const expected = st.draftMetaByPath[file]?.base ?? (shown !== undefined ? versionStamp(shown) : undefined)
      void window.api.fs
        .writeFile(file, next, expected !== undefined ? { expected } : undefined)
        .then((res) => {
          if (res.ok) {
            noteSavedOnMac(file, next)
            saved()
            return
          }
          if (res.disk === undefined) {
            console.error(`[fs] save of ${pathBasename(file)} refused: it changed on disk and is no longer a text file`)
            return
          }
          const diskNow = res.disk
          console.info(`[versions] save of ${pathBasename(file)} refused: it changed on disk since the edit began, asking which version to keep`)
          const after = useAppStore.getState()
          const draftNow = after.draftsByPath[file]
          if (draftNow === diskNow) setDraft(file, null)
          else if (draftNow !== undefined) {
            if (!after.draftMetaByPath[file] && expected !== undefined) after.setDraftMeta(file, { base: expected, by: 'mac' })
            askAfterSaveRef.current = file
          }
          setLoaded((prev) => (prev && prev.path === file && prev.kind === 'text' ? { ...prev, disk: diskNow } : prev))
        })
        .catch((err: unknown) => {
          console.error('[fs] save failed:', err)
        })
    },
    [selectedFile, isLog, setDraft]
  )

  const copyRelPath = (): void => {
    if (!selectedFile || window.getSelection()?.toString()) return
    void window.api.ui.writeClipboardText(relativePath(rootPath, selectedFile))
    setCopiedRel(true)
    window.setTimeout(() => setCopiedRel(false), 1500)
  }
  const copyAbsPath = (): void => {
    if (!selectedFile) return
    void window.api.ui.writeClipboardText(selectedFile)
  }

  const exportRef = useRef<(() => void) | null>(null)
  const viewerActions: ActionNode[] = !selectedFile
    ? []
    : [
        section('file', [
          { id: 'viewer.copyRel', label: 'Copy relative path', icon: 'doc.on.doc', run: () => void window.api.ui.writeClipboardText(relativePath(rootPath, selectedFile)) },
          { id: 'viewer.copyAbs', label: 'Copy full path', icon: 'doc.on.clipboard', run: copyAbsPath },
          { id: 'viewer.reveal', label: 'Reveal in Finder', icon: 'folder', run: () => void window.api.shell.showItemInFolder(selectedFile) }
        ]),
        section('view', [
          isText && (isMarkdown || isReport || isPage) && {
            id: 'viewer.mode',
            label: 'View',
            icon: 'eye',
            children: [
              { id: 'viewer.mode.preview', label: isReport ? 'Report' : isPage ? 'Page' : 'Preview', checked: markdownView === 'preview', run: () => setMarkdownView(tabId, 'preview') },
              { id: 'viewer.mode.source', label: 'Source', checked: markdownView === 'source', run: () => setMarkdownView(tabId, 'source') }
            ]
          },
          findable && { id: 'viewer.find', label: 'Find in this view', icon: 'magnifyingglass', shortcut: 'mod+f', run: () => setFind((f) => ({ seq: (f?.seq ?? 0) + 1 })) },
          isText && !rendered && isLog && { id: 'viewer.live', label: 'Live', icon: 'dot.radiowaves.left.and.right', checked: live, run: () => setViewerLive(tabId, !live) },
          isText && !rendered && isLog && { id: 'viewer.autoscroll', label: 'Autoscroll', icon: 'arrow.down.to.line', checked: logAutoFollow, run: () => setLogAutoFollow(tabId, !logAutoFollow) },
          isText && !rendered && tracked && { id: 'viewer.blame', label: 'Blame', icon: 'person.text.rectangle', checked: blameEnabled, run: () => toggleBlame(selectedFile) },
          (showReport || showPage || isVideo) && { id: 'viewer.reload', label: 'Reload', icon: 'arrow.clockwise', run: () => setReportReloads((n) => n + 1) },
          showReport && { id: 'viewer.export', label: 'Export HTML…', icon: 'square.and.arrow.up', run: () => exportRef.current?.() }
        ]),
        showReport && section('zoom', [
          { id: 'viewer.zoom', label: 'Zoom', icon: 'plus.magnifyingglass', children: [
            { id: 'viewer.zoom.in', label: 'Increase font size', shortcut: 'mod+plus', run: () => useAppStore.getState().adjustReportZoom(1) },
            { id: 'viewer.zoom.out', label: 'Decrease font size', shortcut: 'mod+minus', run: () => useAppStore.getState().adjustReportZoom(-1) },
            { id: 'viewer.zoom.reset', label: 'Reset font size', shortcut: 'mod+0', run: () => useAppStore.getState().adjustReportZoom('reset') }
          ] }
        ]),
        twoVersions && section('versions', [
          { id: 'viewer.versions', label: 'Two versions…', icon: 'exclamationmark.triangle', run: () => openVersions(selectedFile) },
          { id: 'viewer.compareVersions', label: 'Compare versions', icon: 'rectangle.split.2x1', run: () => showCompare(selectedFile) },
          { id: 'viewer.keepMine', label: 'Keep my edits', icon: 'checkmark', run: () => void keepMine(selectedFile) },
          { id: 'viewer.takeOther', label: versionNames(thisDevice(), pushConflict ? 'push' : 'disk', pushConflict?.from ?? 'disk', metaBy ?? null).take, icon: 'arrow.down.doc', destructive: true, run: () => void takeOther(selectedFile) }
        ])
      ].filter(Boolean) as ActionNode[]
  usePanelActions(tabId, compact(viewerActions))

  if (!selectedFile) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas text-center">
        <p className="text-sm text-zinc-400">No file open</p>
        <p className="max-w-xs px-6 text-xs text-zinc-600">
          Pick a file in the <span className="text-zinc-500">Explorer</span> to view it here.
        </p>
      </div>
    )
  }

  if (reportLocRef.current.path !== selectedFile) {
    const held = takeReportLocation(selectedFile)
    if (held) reportLocRef.current = { path: selectedFile, loc: held }
  }
  const relPath = relativePath(rootPath, selectedFile)
  const reloadReport = (): void => setReportReloads((n) => n + 1)
  const [exporting, setExporting] = useState<
    { kind: 'busy'; text: string } | { kind: 'done'; file: string; text: string; warn: string } | { kind: 'error'; text: string } | null
  >(null)
  useEffect(() => {
    if (!exporting || exporting.kind === 'busy') return
    const t = window.setTimeout(() => setExporting(null), exporting.kind === 'error' || exporting.warn ? 12000 : 8000)
    return () => window.clearTimeout(t)
  }, [exporting])
  exportRef.current = () => void exportReport()
  const exportReport = async (): Promise<void> => {
    if (!selectedFile || exporting?.kind === 'busy') return
    const picked = await pickPath({
      mode: 'save',
      purpose: 'report-export',
      title: 'Export report as HTML',
      confirmLabel: 'Export',
      defaultPath: (await window.api.picker.places().catch(() => null))?.places.find((p) => p.kind === 'downloads')?.path,
      defaultName: exportFileName(selectedFile),
      filters: [{ name: 'HTML page', extensions: ['html', 'htm'] }]
    })
    if (!picked) return
    const out = /\.html?$/i.test(picked) ? picked : `${picked}.html`
    setExporting({ kind: 'busy', text: 'Exporting…' })
    const res = await exportReportHtml(selectedFile, rootPath, out, (n) => setExporting({ kind: 'busy', text: `Exporting… ${n} report${n === 1 ? '' : 's'}` }))
    if (!res.ok) {
      setExporting({ kind: 'error', text: res.error })
      return
    }
    const size = res.bytes >= 10 * 1024 * 1024 ? `${Math.round(res.bytes / (1024 * 1024))} MB` : `${(res.bytes / (1024 * 1024)).toFixed(1)} MB`
    const pages = res.pages > 1 ? ` · ${res.pages} reports` : ''
    setExporting({ kind: 'done', file: res.file, text: `Exported ${size}${pages}`, warn: res.warnings.join('\n') })
  }
  const openFromReport = (path: string, loc: ReportLocation): void => {
    if (isReactReport(path) || isHtmlPage(path)) {
      const st = useAppStore.getState()
      const groupId = Object.values(st.tabsByWorkspace).flat().find((t) => t.id === tabId)?.groupId
      holdReportLocation(path, loc)
      if (!openFileInWorkbench({ file: path, projectPath: rootPath, newTab: true, sourceGroupId: groupId })) takeReportLocation(path)
      return
    }
    openFileInWorkbench({ file: path, projectPath: rootPath })
  }
  const openFromReportAt = (path: string, line?: number, column?: number): void => {
    openFileInWorkbench({ file: path, line, column, projectPath: rootPath })
  }

  return (
    <div
      className="absolute inset-0 flex flex-col bg-canvas"
      onMouseDownCapture={(e) => {
        if ((e.target as HTMLElement | null)?.closest('.find-widget')) return
        if (selectedFile) noteViewerFocus(selectedFile)
      }}
    >
      {}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/[0.06] bg-canvas px-3">
        <span
          onClick={copyRelPath}
          onContextMenu={(e) => {
            e.preventDefault()
            setPathMenu({ x: e.clientX, y: e.clientY })
          }}
          className="min-w-0 flex-1 cursor-pointer select-text truncate text-xs text-zinc-300 hover:text-zinc-100"
          title="Click to copy relative path · right-click for full path"
        >
          {dirty && <span className="mr-1.5 text-amber-400" aria-hidden>•</span>}
          {showReport && reportTitle ? (
            <>
              <span className="font-medium text-zinc-100">{reportTitle}</span>
              <span className="ml-2 text-zinc-500">{relPath || pathBasename(selectedFile)}</span>
            </>
          ) : (
            relPath || pathBasename(selectedFile)
          )}
        </span>
        {copiedRel && <span className="shrink-0 text-[11px] text-emerald-400">Copied</span>}
        {isText && !rendered && isLog && (
          <button
            onClick={() => setViewerLive(tabId, !live)}
            title={
              live
                ? 'Live: re-reading from disk every second — click to stop'
                : 'Live: re-read this file from disk every second (for tailing logs)'
            }
            className={`flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs ${
              live ? 'text-ink' : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`}
            />
            Live
          </button>
        )}
        {isText && !rendered && isLog && (
          <button
            onClick={() => setLogAutoFollow(tabId, !logAutoFollow)}
            title={
              logAutoFollow
                ? 'Autoscroll: following the newest lines — click to stop'
                : 'Autoscroll: jump to and follow the newest lines'
            }
            className={`flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs ${
              logAutoFollow ? 'text-ink' : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
            Autoscroll
          </button>
        )}
        {isText && !rendered && tracked && (
          <button
            onClick={() => selectedFile && toggleBlame(selectedFile)}
            title="Toggle Git Blame"
            className={`shrink-0 rounded px-2 py-0.5 text-xs ${
              blameEnabled
                ? 'text-ink hover:bg-white/[0.07]'
                : 'text-ink-3 hover:bg-white/[0.07] hover:text-ink-2'
            }`}
          >
            Blame
          </button>
        )}
        {(showReport || showPage || isVideo) && (
          <button
            onClick={reloadReport}
            title="Reload (⌘R inside the report)"
            className="flex shrink-0 items-center rounded px-1.5 py-0.5 text-zinc-400 hover:bg-white/10 hover:text-white"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
        )}
        {exporting && (
          <span className="flex min-w-0 shrink items-center" data-report-export={exporting.kind}>
            {exporting.kind === 'done' ? (
              <button
                onClick={() => void window.api.shell.showItemInFolder(exporting.file)}
                title={`${exporting.file}${exporting.warn ? `\n\n${exporting.warn}` : ''}\n\nClick to show it in the folder`}
                className={`truncate rounded px-1.5 py-0.5 text-[11px] hover:bg-white/[0.07] ${exporting.warn ? 'text-amber-400' : 'text-emerald-400'}`}
              >
                {exporting.text}
                {exporting.warn ? ' · large file' : ''}
              </button>
            ) : (
              <span
                title={exporting.kind === 'error' ? exporting.text : undefined}
                className={`truncate text-[11px] ${exporting.kind === 'error' ? 'text-rose-400' : 'text-ink-3'}`}
              >
                {exporting.kind === 'error' ? `Export failed: ${exporting.text.split('\n')[0]}` : exporting.text}
              </span>
            )}
          </span>
        )}
        {showReport && (
          <button
            onClick={() => void exportReport()}
            disabled={exporting?.kind === 'busy'}
            title="Export HTML… One file with the linked reports, videos and images that opens in any browser"
            data-report-export-button
            className="flex shrink-0 items-center rounded px-1.5 py-0.5 text-zinc-400 hover:bg-white/10 hover:text-white disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12" />
              <path d="M7 10l5 5 5-5" />
              <path d="M5 21h14" />
            </svg>
          </button>
        )}
        {isText && (isMarkdown || isReport || isPage) && (
          <div className="flex shrink-0 items-center gap-1 text-xs">
            <button
              onClick={() => setMarkdownView(tabId, 'preview')}
              className={`px-2 py-0.5 ${markdownView === 'preview' ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}
            >
              {isReport ? 'Report' : isPage ? 'Page' : 'Preview'}
            </button>
            <button
              onClick={() => setMarkdownView(tabId, 'source')}
              className={`px-2 py-0.5 ${markdownView === 'source' ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}
            >
              Source
            </button>
          </div>
        )}
      </div>

      {
}
      {twoVersions && (
        <div
          data-file-versions-bar
          className={`flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 text-amber-200 ${isMobileLayout() ? 'min-h-11 px-3 py-1.5 text-[13px]' : 'h-8 px-3 text-xs'}`}
        >
          <TriangleAlert size={isMobileLayout() ? 15 : 13} className="shrink-0 text-amber-300" />
          <span className="min-w-0 flex-1 truncate">This file has two different versions.</span>
          <button
            onClick={() => showCompare(selectedFile)}
            className={`shrink-0 rounded border border-amber-400/40 text-amber-100 hover:bg-amber-400/20 ${isMobileLayout() ? 'px-3 py-1.5' : 'px-2 py-0.5'}`}
          >
            Compare
          </button>
          <button
            onClick={() => openVersions(selectedFile)}
            className={`shrink-0 rounded border border-amber-400/40 text-amber-100 hover:bg-amber-400/20 ${isMobileLayout() ? 'px-3 py-1.5' : 'px-2 py-0.5'}`}
          >
            Resolve…
          </button>
        </div>
      )}

      {pathMenu && (
        <FloatingMenu x={pathMenu.x} y={pathMenu.y} onDismiss={() => setPathMenu(null)}>
          <button
            className={menuItemClass}
            onClick={() => {
              copyAbsPath()
              setPathMenu(null)
            }}
          >
            Copy full path
          </button>
          <button
            className={menuItemClass}
            onClick={() => {
              if (selectedFile) void window.api.shell.showItemInFolder(selectedFile)
              setPathMenu(null)
            }}
          >
            Reveal in Finder
          </button>
        </FloatingMenu>
      )}

      {}
      <div
        ref={contentRef}
        className="relative min-h-0 flex-1"
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || !find || e.defaultPrevented) return
          if ((e.target as HTMLElement | null)?.closest('[role="dialog"]')) return
          setFind(null)
        }}
      >
        {findable && find && (
          <FindInViewBar
            key={`${selectedFile}\n${showReport ? 'report' : 'md'}`}
            containerRef={contentRef}
            rootSelector={showReport ? '.rk-host' : '.satura-markdown'}
            focusSeq={find.seq}
            onClose={() => setFind(null)}
          />
        )}
        {loaded?.kind === 'loading' && (
          <Centered>
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
          </Centered>
        )}
        {loaded?.kind === 'notFound' && (
          <Centered>
            <div className="flex max-w-md flex-col items-center gap-2 px-6">
              <p className="text-sm text-zinc-300">File not found</p>
              <p className="break-all text-xs text-zinc-500">{relPath}</p>
              <p className="text-xs text-zinc-600">
                {isLog
                  ? "This log hasn't been written yet — the editor may not have started."
                  : "It may have been moved or deleted since it was opened."}
              </p>
            </div>
          </Centered>
        )}
        {loaded?.kind === 'error' && (
          <Centered>
            <div className="flex max-w-md flex-col items-center gap-2 px-6">
              <p className="text-sm text-rose-300">Couldn’t open this file</p>
              <p className="break-words text-xs text-zinc-500">{loaded.message}</p>
            </div>
          </Centered>
        )}
        {loaded?.kind === 'binary' && (
          <Centered>
            <p className="text-sm text-zinc-400">Binary file — not shown</p>
          </Centered>
        )}
        {loaded?.kind === 'tooLarge' && (
          <Centered>
            <p className="text-sm text-zinc-400">
              File too large to display ({(loaded.bytes / (1024 * 1024)).toFixed(1)} MB)
            </p>
          </Centered>
        )}
        {loaded?.kind === 'image' && (
          <ImagePanZoom key={loaded.path} src={loaded.dataUrl} alt={relPath} />
        )}
        {loaded?.kind === 'audio' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6" data-viewer-audio>
            <p className="max-w-full truncate text-sm text-zinc-400">{pathBasename(loaded.path)}</p>
            <audio key={loaded.url} src={loaded.url} controls className="w-full max-w-md" />
          </div>
        )}
        {loaded?.kind === 'video' && (
          <div className="absolute inset-0 bg-black" data-viewer-video>
            <FramePlayer key={`${loaded.url}.${reportReloads}`} src={loaded.url} className="absolute inset-0" />
          </div>
        )}
        {showReport && (
          <ReportPanel
            stateKey={tabId}
            file={selectedFile}
            rootPath={rootPath}
            diskStamp={versionStamp(disk)}
            reloads={reportReloads}
            initial={reportLocRef.current.path === selectedFile ? reportLocRef.current.loc : null}
            onTitle={(t) => {
              setReportTitle(t)
              if (t.trim()) noteReportTitles({ [selectedFile]: t })
            }}
            onReload={reloadReport}
            onOpenReport={openFromReport}
            onOpenFile={openFromReportAt}
          />
        )}
        {showPage && (
          <div className="absolute inset-0" data-viewer-page>
            <iframe
              key={selectedFile}
              src={`${reportUrlForPath(selectedFile)}?v=${versionStamp(disk)}.${reportReloads}`}
              sandbox="allow-scripts allow-popups"
              title={pathBasename(selectedFile)}
              className="absolute inset-0 h-full w-full border-0 bg-white"
            />
          </div>
        )}
        {showPreview && (
          <PaneErrorBoundary label="Markdown preview">
            <Suspense
              fallback={
                <Centered>
                  <p className="text-xs text-zinc-500">Loading preview…</p>
                </Centered>
              }
            >
              <MarkdownView content={value} filePath={selectedFile} fontSize={editorFontSize} stateKey={tabId} />
            </Suspense>
          </PaneErrorBoundary>
        )}
        {comparing && isText && twoVersions && (
          <Suspense fallback={null}>
            <FileVersionsCompare
              file={selectedFile}
              mine={value}
              theirs={pushConflict ? (remoteFileSink()?.macVersion(selectedFile) ?? disk) : disk}
              names={versionNames(thisDevice(), pushConflict ? 'push' : 'disk', pushConflict?.from ?? 'disk', metaBy ?? null)}
              language={languageFromPath(selectedFile)}
              fontSize={editorFontSize}
              onKeep={() => void keepMine(selectedFile)}
              onTake={() => void takeOther(selectedFile)}
              onClose={closeCompare}
            />
          </Suspense>
        )}
        {isText && !rendered && (
          <PaneErrorBoundary label="Editor">
            <Suspense
              fallback={
                <Centered>
                  <p className="text-xs text-zinc-500">Loading editor…</p>
                </Centered>
              }
            >
              <MonacoEditor
                path={selectedFile}
                rootPath={rootPath}
                value={value}
                language={languageFromPath(selectedFile)}
                onChange={onChange}
                onSave={save}
                wrap={editorWordWrap}
                onToggleWrap={toggleEditorWordWrap}
                fontSize={editorFontSize}
                themeId={themeId}
                readOnly={isLog}
                blame={blameActive}
                dirty={dirty}
                onToggleBlame={isLog ? undefined : () => selectedFile && toggleBlame(selectedFile)}
                blameAvailable={tracked}
                onShowCommit={(hash) => openGitCommitFromTab(tabId, hash)}
                followTail={isLog && logAutoFollow}
                onFollowTailChange={isLog ? (on) => setLogAutoFollow(tabId, on) : undefined}
                actionScope={tabId}
                hotReloadGuard={hotReloadGuard}
              />
            </Suspense>
          </PaneErrorBoundary>
        )}
      </div>
    </div>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="absolute inset-0 flex items-center justify-center text-center">{children}</div>
}
