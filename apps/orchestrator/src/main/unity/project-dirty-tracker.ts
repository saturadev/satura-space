import type { CompileState } from '@shared/unity/world'

export class ProjectDirtyTracker {
  private seq = 0
  private clean = false
  private broken = false
  private record: { targetGen: number; seqAtRecord: number; at: number } | null = null
  private cleanAt: number | null = null
  private execSeq: number | null = null
  private execAt: number | null = null

  fileEvent(): void {
    this.seq++
    this.clean = false
  }

  markBroken(): void {
    this.broken = true
    this.clean = false
    this.record = null
    this.execSeq = null
    this.execAt = null
  }

  needsRefresh(): boolean {
    return this.broken || !this.clean
  }

  needsRefreshBeforePlay(): boolean {
    if (!this.needsRefresh()) return false
    return this.broken || !this.record || this.seq !== this.record.seqAtRecord
  }

  cleanSince(): number | null {
    return this.clean && !this.broken ? this.cleanAt : null
  }

  execCanSkipRefresh(): boolean {
    if (this.broken) return false
    return this.clean || this.execSeq === this.seq
  }

  execRefreshIssued(): void {
    if (this.broken) return
    this.execSeq = this.seq
    this.execAt = Date.now()
  }

  skipSince(): number | null {
    if (this.broken) return null
    if (this.clean) return this.cleanAt
    return this.execSeq === this.seq ? this.execAt : null
  }

  onDesired(desiredPrimaryGen: number, observedPrimaryGen: number): void {
    if (this.broken) return
    if (desiredPrimaryGen <= observedPrimaryGen) return
    if (this.record && desiredPrimaryGen <= this.record.targetGen) return
    this.record = { targetGen: desiredPrimaryGen, seqAtRecord: this.seq, at: Date.now() }
  }

  onObserved(observedPrimaryGen: number, compile: CompileState): void {
    if (!this.record || observedPrimaryGen < this.record.targetGen) return
    if (compile === 'compiling') return
    if (compile === 'idle' && !this.broken) this.clean = this.seq === this.record.seqAtRecord
    else this.clean = false
    this.cleanAt = this.clean ? this.record.at : null
    this.record = null
  }
}
