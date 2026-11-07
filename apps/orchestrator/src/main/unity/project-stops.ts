import type { WorldStore } from './world-store'
import { censusTrack } from '@shared/census'

type StopStore = Pick<WorldStore, 'isStopped' | 'setDesired' | 'resyncSubscriber'>

export class ProjectStops {
  private readonly parked = censusTrack('project-stops.parked', new Map<string, Map<string, number>>())
  private readonly inFlight = censusTrack('project-stops.inFlight', new Set<string>())

  constructor(
    private readonly store: StopStore,
    private readonly log: (message: string) => void = (m) => console.log(m),
    private readonly onWatchChange: (projectPath: string) => void = () => {}
  ) {}

  isStopped(projectPath: string): boolean {
    return this.store.isStopped(projectPath)
  }

  begin(projectPath: string, subscribers: Iterable<[string, number]>): void {
    this.inFlight.add(projectPath)
    this.park(projectPath, subscribers)
    this.store.setDesired(projectPath, { stopped: true, playerCount: 1 })
  }

  park(projectPath: string, subscribers: Iterable<[string, number]>): void {
    let added = false
    for (const [unityId, wcId] of subscribers) {
      let subs = this.parked.get(projectPath)
      if (!subs) {
        subs = new Map()
        this.parked.set(projectPath, subs)
        added = true
      }
      subs.set(unityId, wcId)
    }
    if (added) this.onWatchChange(projectPath)
  }

  finish(projectPath: string): void {
    for (const [unityId, wcId] of this.parked.get(projectPath) ?? [])
      this.store.resyncSubscriber(projectPath, unityId, wcId)
    this.inFlight.delete(projectPath)
    this.forgetIfUnwatched(projectPath)
  }

  admit(projectPath: string, unityId: string, wcId: number): boolean {
    if (!this.store.isStopped(projectPath)) {
      this.release(unityId)
      return true
    }
    this.park(projectPath, [[unityId, wcId]])
    this.store.resyncSubscriber(projectPath, unityId, wcId)
    return false
  }

  resume(projectPath: string): void {
    if (this.store.isStopped(projectPath)) this.store.setDesired(projectPath, { stopped: false })
  }

  release(unityId: string): void {
    for (const [pp, subs] of [...this.parked]) {
      if (subs.delete(unityId)) this.forgetIfUnwatched(pp)
    }
  }

  releaseWebContents(wcId: number): void {
    for (const [pp, subs] of [...this.parked]) {
      for (const [unityId, w] of [...subs]) if (w === wcId) subs.delete(unityId)
      this.forgetIfUnwatched(pp)
    }
  }

  reassign(matches: (unityId: string) => boolean, fromWcId: number, toWcId: number): void {
    for (const subs of this.parked.values()) {
      for (const [unityId, w] of subs) if (w === fromWcId && matches(unityId)) subs.set(unityId, toWcId)
    }
  }

  subscribers(projectPath: string): Array<[string, number]> {
    return [...(this.parked.get(projectPath) ?? [])]
  }

  projectOf(unityId: string): string | null {
    for (const [pp, subs] of this.parked) if (subs.has(unityId)) return pp
    return null
  }

  private forgetIfUnwatched(projectPath: string): void {
    if ((this.parked.get(projectPath)?.size ?? 0) > 0) return
    const had = this.parked.delete(projectPath)
    if (this.store.isStopped(projectPath) && !this.inFlight.has(projectPath)) {
      this.log(`[unity] no Player panel left on stopped ${projectPath}; the next one launches Unity again`)
      this.store.setDesired(projectPath, { stopped: false })
    }
    if (had) this.onWatchChange(projectPath)
  }
}
