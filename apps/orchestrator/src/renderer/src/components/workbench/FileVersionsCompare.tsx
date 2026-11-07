import { useMemo } from 'react'
import { MergeConflictCompare } from '../../lib/editor/merge-conflict/MergeConflictCompare'
import { isMobileLayout } from '../../lib/mobile/mobile-back'
import { minimalEdit, type VersionNames } from '../../lib/editor/file-versions'

export default function FileVersionsCompare({
  file,
  mine,
  theirs,
  names,
  language,
  fontSize,
  onKeep,
  onTake,
  onClose
}: {
  file: string
  mine: string
  theirs: string
  names: VersionNames
  language: string
  fontSize: number
  onKeep: () => void
  onTake: () => void
  onClose: () => void
}) {
  const touch = isMobileLayout()
  const request = useMemo(() => {
    const edit = minimalEdit(theirs, mine)
    const line = edit ? mine.slice(0, edit.start).split('\n').length : 1
    return {
      title: `${names.theirs.label} → ${names.mine.label}`,
      original: theirs,
      modified: mine,
      language,
      selection: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }
    }
  }, [file, mine, theirs, names.theirs.label, names.mine.label, language])
  const legend = [`Red: ${names.theirs.label}`, `Green: ${names.mine.label}`]
  const footer = (
    <div
      data-compare-footer
      className={`flex shrink-0 border-t border-hairline bg-panel ${touch ? 'flex-col gap-2 px-3 pt-2' : 'items-center gap-2 px-3 py-2'}`}
      style={touch ? { paddingBottom: 'max(8px, env(safe-area-inset-bottom))' } : undefined}
    >
      <div title={legend.join('\n')} className={`min-w-0 text-ink-3 ${touch ? 'text-[12.5px] leading-snug' : 'flex-1 truncate text-xs'}`}>
        {touch ? legend.map((l) => <div key={l}>{l}</div>) : legend.join(' · ')}
      </div>
      <div className={`flex gap-2 ${touch ? '' : 'shrink-0'}`}>
        <button
          type="button"
          onClick={onTake}
          data-versions-choice="take"
          className={`rounded-md font-medium text-zinc-200 hover:bg-white/10 ${touch ? 'h-11 flex-1 border border-white/15 text-[15px] active:bg-white/10' : 'px-3 py-1 text-xs'}`}
        >
          {names.take}
        </button>
        <button
          type="button"
          onClick={onKeep}
          data-versions-choice="keep"
          className={`rounded-md bg-sky-600 font-medium text-white hover:bg-sky-500 ${touch ? 'h-11 flex-1 text-[15px] active:bg-sky-500' : 'px-3 py-1 text-xs'}`}
        >
          {names.keep}
        </button>
      </div>
    </div>
  )
  return <MergeConflictCompare request={request} fontSize={fontSize} onClose={onClose} footer={footer} touch={touch} />
}
