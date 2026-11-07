import { RefType, type Branch, type Commit, type Ref } from '@shared/git-scm'
import {
  historyItemBaseRefColor,
  historyItemRefColor,
  historyItemRemoteRefColor,
  type ISCMHistoryItem,
  type ISCMHistoryItemRef
} from './scm-history'

const commitShortHashLength = 7

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.substring(0, maxLength)
}

export function subject(message: string): string {
  const newLineIndex = message.indexOf('\n')
  return newLineIndex !== -1 ? message.substring(0, newLineIndex) : message
}

function compareSourceControlHistoryItemRef(ref1: ISCMHistoryItemRef, ref2: ISCMHistoryItemRef): number {
  const getOrder = (ref: ISCMHistoryItemRef): number => {
    if (ref.id.startsWith('refs/heads/')) {
      return 1
    } else if (ref.id.startsWith('refs/remotes/')) {
      return 2
    } else if (ref.id.startsWith('refs/tags/')) {
      return 3
    }

    return 99
  }

  const ref1Order = getOrder(ref1)
  const ref2Order = getOrder(ref2)

  if (ref1Order !== ref2Order) {
    return ref1Order - ref2Order
  }

  return ref1.name.localeCompare(ref2.name)
}

export function resolveHistoryItemRefs(commit: Commit): ISCMHistoryItemRef[] {
  const references: ISCMHistoryItemRef[] = []

  for (const ref of commit.refNames) {
    if (ref === 'refs/remotes/origin/HEAD') {
      continue
    }

    switch (true) {
      case ref.startsWith('HEAD -> refs/heads/'):
        references.push({
          id: ref.substring('HEAD -> '.length),
          name: ref.substring('HEAD -> refs/heads/'.length),
          revision: commit.hash,
          category: 'branches',
          icon: 'head'
        })
        break
      case ref.startsWith('refs/heads/'):
        references.push({
          id: ref,
          name: ref.substring('refs/heads/'.length),
          revision: commit.hash,
          category: 'branches',
          icon: 'branch'
        })
        break
      case ref.startsWith('refs/remotes/'):
        references.push({
          id: ref,
          name: ref.substring('refs/remotes/'.length),
          revision: commit.hash,
          category: 'remote branches',
          icon: 'remoteBranch'
        })
        break
      case ref.startsWith('tag: refs/tags/'):
        references.push({
          id: ref.substring('tag: '.length),
          name: ref.substring('tag: refs/tags/'.length),
          revision: commit.hash,
          category: 'tags',
          icon: 'tag'
        })
        break
    }
  }

  return references.sort(compareSourceControlHistoryItemRef)
}

export function toSourceControlHistoryItemRef(ref: Ref): ISCMHistoryItemRef {
  switch (ref.type) {
    case RefType.RemoteHead:
      return {
        id: `refs/remotes/${ref.name}`,
        name: ref.name ?? '',
        description: ref.commit ? `Remote branch at ${truncate(ref.commit, commitShortHashLength)}` : undefined,
        revision: ref.commit,
        icon: 'remoteBranch',
        category: 'remote branches'
      }
    case RefType.Tag:
      return {
        id: `refs/tags/${ref.name}`,
        name: ref.name ?? '',
        description: ref.commit ? `Tag at ${truncate(ref.commit, commitShortHashLength)}` : undefined,
        revision: ref.commit,
        icon: 'tag',
        category: 'tags'
      }
    default:
      return {
        id: `refs/heads/${ref.name}`,
        name: ref.name ?? '',
        description: ref.commit ? truncate(ref.commit, commitShortHashLength) : undefined,
        revision: ref.commit,
        icon: 'branch',
        category: 'branches'
      }
  }
}

export function provideHistoryItemRefs(refs: Ref[]): ISCMHistoryItemRef[] {
  const branches: ISCMHistoryItemRef[] = []
  const remoteBranches: ISCMHistoryItemRef[] = []
  const tags: ISCMHistoryItemRef[] = []

  for (const ref of refs) {
    switch (ref.type) {
      case RefType.RemoteHead:
        remoteBranches.push(toSourceControlHistoryItemRef(ref))
        break
      case RefType.Tag:
        tags.push(toSourceControlHistoryItemRef(ref))
        break
      default:
        branches.push(toSourceControlHistoryItemRef(ref))
        break
    }
  }

  return [...branches, ...remoteBranches, ...tags]
}

export interface CurrentHistoryItemRefs {
  readonly historyItemRef?: ISCMHistoryItemRef
  readonly historyItemRemoteRef?: ISCMHistoryItemRef
  readonly historyItemBaseRef?: ISCMHistoryItemRef
}

export function resolveCurrentHistoryItemRefs(HEAD: Branch | undefined): CurrentHistoryItemRefs {
  if (!HEAD) {
    return {}
  }

  let historyItemRefId = ''
  let historyItemRefName = ''
  let historyItemRemoteRef: ISCMHistoryItemRef | undefined

  switch (HEAD.type) {
    case RefType.Head: {
      if (HEAD.name !== undefined) {
        historyItemRefId = `refs/heads/${HEAD.name}`
        historyItemRefName = HEAD.name

        if (HEAD.upstream) {
          if (HEAD.upstream.remote === '.') {
            historyItemRemoteRef = {
              id: `refs/heads/${HEAD.upstream.name}`,
              name: HEAD.upstream.name,
              revision: HEAD.upstream.commit,
              icon: 'branch',
              color: historyItemRemoteRefColor
            }
          } else {
            historyItemRemoteRef = {
              id: `refs/remotes/${HEAD.upstream.remote}/${HEAD.upstream.name}`,
              name: `${HEAD.upstream.remote}/${HEAD.upstream.name}`,
              revision: HEAD.upstream.commit,
              icon: 'remoteBranch',
              color: historyItemRemoteRefColor
            }
          }
        }
      } else {
        historyItemRefId = HEAD.commit ?? ''
        historyItemRefName = HEAD.commit ?? ''
      }
      break
    }
    case RefType.Tag: {
      historyItemRefId = `refs/tags/${HEAD.name}`
      historyItemRefName = HEAD.name ?? HEAD.commit ?? ''
      break
    }
  }

  return {
    historyItemRef: {
      id: historyItemRefId,
      name: historyItemRefName,
      revision: HEAD.commit,
      icon: 'head',
      color: historyItemRefColor
    },
    historyItemRemoteRef,
    historyItemBaseRef: undefined
  }
}

export function toHistoryItem(commit: Commit): ISCMHistoryItem {
  const references = resolveHistoryItemRefs(commit)
  return {
    id: commit.hash,
    parentIds: commit.parents,
    subject: subject(commit.message),
    message: commit.message,
    author: commit.authorName,
    authorEmail: commit.authorEmail,
    displayId: truncate(commit.hash, commitShortHashLength),
    timestamp: commit.authorDate,
    statistics: commit.shortStat ?? { files: 0, insertions: 0, deletions: 0 },
    references: references.length !== 0 ? references : undefined
  }
}

export function getGraphColorMap(
  historyItemRefs: ISCMHistoryItemRef[],
  current: CurrentHistoryItemRefs
): Map<string, string | undefined> {
  const { historyItemRef, historyItemRemoteRef, historyItemBaseRef } = current

  const colorMap = new Map<string, string | undefined>()

  if (historyItemRef) {
    colorMap.set(historyItemRef.id, historyItemRef.color)

    if (historyItemRemoteRef) {
      colorMap.set(historyItemRemoteRef.id, historyItemRemoteRef.color)
    }
    if (historyItemBaseRef) {
      colorMap.set(historyItemBaseRef.id, historyItemBaseRef.color ?? historyItemBaseRefColor)
    }
  }

  for (const ref of historyItemRefs) {
    if (!colorMap.has(ref.id)) {
      colorMap.set(ref.id, undefined)
    }
  }

  return colorMap
}
