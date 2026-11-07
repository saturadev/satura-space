import { FloatingMenu, MenuSeparator, menuItemClass } from '../ui/FloatingMenu'

export function PaneFileExplorerContextMenu({
  x,
  y,
  isDir,
  isRoot,
  count,
  onDismiss,
  onNewFile,
  onNewFolder,
  onCopyPath,
  onCopyRelativePath,
  onDuplicate,
  onReveal,
  onFindInFolder,
  onShowHistory,
  onOpenAsText,
  onOpenInTuner,
  onRename,
  onDelete
}: {
  x: number
  y: number
  isDir: boolean
  isRoot: boolean
  count: number
  onDismiss: () => void
  onNewFile: () => void
  onNewFolder: () => void
  onCopyPath: () => void
  onCopyRelativePath: () => void
  onDuplicate: () => void
  onReveal: () => void
  onFindInFolder: () => void
  onShowHistory?: () => void
  onOpenAsText?: () => void
  onOpenInTuner?: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const run = (fn: () => void) => (): void => {
    fn()
    onDismiss()
  }
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)

  if (count > 1) {
    return (
      <FloatingMenu x={x} y={y} onDismiss={onDismiss}>
        {onShowHistory && (
          <>
            <button className={menuItemClass} onClick={run(onShowHistory)}>
              Show History of {count} Items
            </button>
            <MenuSeparator />
          </>
        )}
        <button className={menuItemClass} onClick={run(onCopyPath)}>
          Copy {count} Paths
        </button>
        <button className={menuItemClass} onClick={run(onCopyRelativePath)}>
          Copy {count} Relative Paths
        </button>
      </FloatingMenu>
    )
  }

  return (
    <FloatingMenu x={x} y={y} onDismiss={onDismiss}>
      {onOpenInTuner && (
        <>
          <button className={menuItemClass} data-explorer-open-tuner onClick={run(onOpenInTuner)}>
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
              <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
              <circle cx="12" cy="12" r="1.5" />
            </svg>
            Open in Tuner
          </button>
          <MenuSeparator />
        </>
      )}
      <button className={menuItemClass} onClick={run(onNewFile)}>
        New File
      </button>
      <button className={menuItemClass} onClick={run(onNewFolder)}>
        New Folder
      </button>

      {!isRoot && (
        <>
          <MenuSeparator />
          {onOpenAsText && (
            <button className={menuItemClass} data-explorer-open-text onClick={run(onOpenAsText)}>
              Open as Text
            </button>
          )}
          <button className={menuItemClass} onClick={run(onCopyPath)}>
            Copy Path
          </button>
          <button className={menuItemClass} onClick={run(onCopyRelativePath)}>
            Copy Relative Path
          </button>
          {!isDir && (
            <button className={menuItemClass} onClick={run(onDuplicate)}>
              Duplicate
            </button>
          )}
          <button className={menuItemClass} onClick={run(onReveal)}>
            {isMac ? 'Reveal in Finder' : 'Reveal in File Manager'}
          </button>
          {isDir && (
            <button className={menuItemClass} onClick={run(onFindInFolder)}>
              Find in Folder
            </button>
          )}
          {onShowHistory && (
            <button className={menuItemClass} onClick={run(onShowHistory)}>
              {isDir ? 'Show Folder History' : 'Show File History'}
            </button>
          )}
          <MenuSeparator />
          <button className={menuItemClass} onClick={run(onRename)}>
            Rename
          </button>
          <button
            className={`${menuItemClass} text-rose-300 hover:text-rose-200`}
            onClick={run(onDelete)}
          >
            Delete
          </button>
        </>
      )}
    </FloatingMenu>
  )
}
