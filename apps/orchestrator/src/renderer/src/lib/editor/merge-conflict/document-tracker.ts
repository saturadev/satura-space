import type * as vscode from './vscode'
import { MergeConflictParser } from './merge-conflict-parser'
import type * as interfaces from './interfaces'
import { Delayer } from './delayer'

class ScanTask {
  public origins: Set<string> = new Set<string>()
  public delayTask: Delayer<interfaces.IDocumentMergeConflict[]>

  constructor(delayTime: number, initialOrigin: string) {
    this.origins.add(initialOrigin)
    this.delayTask = new Delayer<interfaces.IDocumentMergeConflict[]>(delayTime)
  }

  public addOrigin(name: string): void {
    this.origins.add(name)
  }

  public hasOrigin(name: string): boolean {
    return this.origins.has(name)
  }
}

class OriginDocumentMergeConflictTracker implements interfaces.IDocumentMergeConflictTracker {
  constructor(private parent: DocumentMergeConflictTracker, private origin: string) {
  }

  getConflicts(document: vscode.TextDocument): PromiseLike<interfaces.IDocumentMergeConflict[]> {
    return this.parent.getConflicts(document, this.origin)
  }

  isPending(document: vscode.TextDocument): boolean {
    return this.parent.isPending(document, this.origin)
  }

  forget(document: vscode.TextDocument) {
    this.parent.forget(document)
  }
}

export default class DocumentMergeConflictTracker implements interfaces.IDocumentMergeConflictTrackerService {
  private cache: Map<string, ScanTask> = new Map()
  private delayExpireTime: number = 0

  getConflicts(document: vscode.TextDocument, origin: string): PromiseLike<interfaces.IDocumentMergeConflict[]> {
    const key = this.getCacheKey(document)

    if (!key) {
      return Promise.resolve(this.getConflictsOrEmpty(document, [origin]))
    }

    let cacheItem = this.cache.get(key)
    if (!cacheItem) {
      cacheItem = new ScanTask(this.delayExpireTime, origin)
      this.cache.set(key, cacheItem)
    }
    else {
      cacheItem.addOrigin(origin)
    }

    return cacheItem.delayTask.trigger(() => {
      const conflicts = this.getConflictsOrEmpty(document, Array.from(cacheItem!.origins))

      this.cache?.delete(key!)

      return conflicts
    })
  }

  isPending(document: vscode.TextDocument, origin: string): boolean {
    if (!document) {
      return false
    }

    const key = this.getCacheKey(document)
    if (!key) {
      return false
    }

    const task = this.cache.get(key)
    if (!task) {
      return false
    }

    return task.hasOrigin(origin)
  }

  createTracker(origin: string): interfaces.IDocumentMergeConflictTracker {
    return new OriginDocumentMergeConflictTracker(this, origin)
  }

  forget(document: vscode.TextDocument) {
    const key = this.getCacheKey(document)

    if (key) {
      this.cache.delete(key)
    }
  }

  dispose() {
    this.cache.clear()
  }

  private getConflictsOrEmpty(document: vscode.TextDocument, _origins: string[]): interfaces.IDocumentMergeConflict[] {
    const containsConflict = MergeConflictParser.containsConflict(document)

    if (!containsConflict) {
      return []
    }

    return MergeConflictParser.scanDocument(document)
  }

  private getCacheKey(document: vscode.TextDocument): string | null {
    if (document.uri) {
      return document.uri.toString()
    }

    return null
  }
}
