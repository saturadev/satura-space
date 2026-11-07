import type { ScmDiffExplanation } from '@shared/git-scm'

export interface DiffNote {
  readonly text: string
  readonly reveal?: 'whitespace' | 'diff'
}

const MODE_NAMES: Record<string, string> = {
  '100644': 'file',
  '100755': 'executable file',
  '120000': 'symlink',
  '160000': 'submodule',
  '040000': 'folder'
}

const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/

function stripBom(text: string): string {
  return text.startsWith('﻿') ? text.slice(1) : text
}

function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function withoutWhitespace(text: string): string {
  return normalizeEol(stripBom(text)).split('\n').map((l) => l.replace(/\s+/g, '')).join('\n')
}

function eolOf(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  const cr = (text.match(/\r(?!\n)/g) ?? []).length
  const kinds = [crlf && 'CRLF', lf && 'LF', cr && 'CR'].filter(Boolean) as string[]
  return kinds.length === 0 ? 'none' : kinds.length === 1 ? kinds[0] : 'mixed'
}

function short(object: string | undefined): string {
  return object ? object.substring(0, 8) : ''
}

function isZero(object: string | undefined): boolean {
  return !object || /^0+$/.test(object)
}

function modeName(mode: string): string {
  return MODE_NAMES[mode] ?? `mode ${mode}`
}

export function maybeContentOnly(original: string, modified: string): boolean {
  return original === modified || withoutWhitespace(original) === withoutWhitespace(modified)
}

export function describeDiff(
  original: string,
  modified: string,
  originalPath: string,
  modifiedPath: string,
  x: ScmDiffExplanation | undefined
): DiffNote | undefined {
  const oldMode = x?.oldMode && x.oldMode !== '000000' ? x.oldMode : undefined
  const newMode = x?.newMode && x.newMode !== '000000' ? x.newMode : undefined

  if (oldMode === '160000' && newMode === '160000') {
    return isZero(x?.newObject) || x?.newObject === x?.oldObject
      ? { text: 'The submodule has new commits or local changes inside it.' }
      : { text: `Submodule commit changed: ${short(x?.oldObject)} → ${short(x?.newObject)}.` }
  }

  if (oldMode === '120000' && newMode === '120000' && x?.oldTarget !== undefined && x.newTarget !== undefined) {
    return x.oldTarget === x.newTarget
      ? { text: `Symlink to ${x.newTarget}, no changes.` }
      : { text: `Symlink target changed: ${x.oldTarget} → ${x.newTarget}.` }
  }

  const modeNote = oldMode && newMode && oldMode !== newMode
    ? oldMode.startsWith('100') && newMode.startsWith('100')
      ? `Only the file mode changed: ${oldMode} → ${newMode}`
      : `Changed from a ${modeName(oldMode)} to a ${modeName(newMode)} (${oldMode} → ${newMode})`
    : undefined

  if (modeNote && (oldMode === '160000' || newMode === '160000' || oldMode === '120000' || newMode === '120000')) {
    return { text: `${modeNote}.` }
  }

  if (original === modified) {
    if (originalPath !== modifiedPath) {
      return {
        text: modeNote
          ? `Renamed from ${originalPath}, no content changes. The file mode changed too: ${oldMode} → ${newMode}.`
          : `Renamed from ${originalPath}, no content changes.`
      }
    }
    if (modeNote) return { text: `${modeNote}.` }
    if (x?.refreshed) return { text: "No content changes, only the file's timestamp changed." }
    return { text: 'The files are identical.' }
  }

  const originalBom = original.startsWith('﻿')
  const modifiedBom = modified.startsWith('﻿')
  if (originalBom !== modifiedBom && stripBom(original) === stripBom(modified)) {
    return { text: `Only the byte order mark (BOM) was ${modifiedBom ? 'added' : 'removed'}.` }
  }

  if (normalizeEol(stripBom(original)) === normalizeEol(stripBom(modified))) {
    return x?.sameContent
      ? { text: `Only line endings differ (${eolOf(modified)} in the file, ${eolOf(original)} in git). Git converts them on commit, so there is nothing to commit.` }
      : { text: `Only line endings changed (${eolOf(original)} → ${eolOf(modified)}).` }
  }

  if (withoutWhitespace(original) === withoutWhitespace(modified)) {
    return { text: 'Only whitespace changed.', reveal: 'whitespace' }
  }

  if (LFS_POINTER.test(original) !== LFS_POINTER.test(modified)) {
    return { text: "One side is a Git LFS pointer and the other is the file content, so this isn't a real text diff.", reveal: 'diff' }
  }

  return undefined
}
