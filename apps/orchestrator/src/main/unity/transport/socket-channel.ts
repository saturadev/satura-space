
import { applyWorldPatch } from '@shared/unity/patch'
import { WORLD_EVENT, isWorldEvent, type WorldPatchEvent, type WorldSnapshotEvent } from '@shared/unity/protocol'
import type { ControlEvent } from '@shared/control-protocol'
import type { WorldObserved } from '@shared/unity/world'
import { UnityControlClient } from '../unity-control-client'

const REQUEST_SNAPSHOT_CMD = 'world/snapshot'

export const SOCKET_CHANNEL_ENABLED = process.env.SS_UNITY_SOCKET_CHANNEL === '1'

const CONNECT_POLL_MS = 500

export interface SocketChannelOptions {
  instanceId: string
  port: number
  host?: string
  enabled?: boolean
  onSnapshot: (instanceId: string, world: WorldObserved) => void
  onConnectedChange?: (instanceId: string, connected: boolean) => void
}

export class SocketChannel {
  private readonly enabled: boolean
  private client: UnityControlClient | null = null
  private offEvent: (() => void) | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private wasConnected = false
  private lastWorld: WorldObserved | null = null

  constructor(private readonly opts: SocketChannelOptions) {
    this.enabled = opts.enabled ?? SOCKET_CHANNEL_ENABLED
    if (!this.enabled) return

    const client = new UnityControlClient(opts.port, opts.host ?? '127.0.0.1')
    this.client = client
    this.offEvent = client.onEvent((e) => this.onEvent(e))
    this.poll = setInterval(() => this.checkConnectivity(), CONNECT_POLL_MS)
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  get isConnected(): boolean {
    return this.client?.isConnected ?? false
  }

  private checkConnectivity(): void {
    const connected = this.isConnected
    if (connected === this.wasConnected) return
    this.wasConnected = connected
    if (connected) {
      this.lastWorld = null
      this.requestSnapshot()
    }
    this.opts.onConnectedChange?.(this.opts.instanceId, connected)
  }

  private requestSnapshot(): void {
    this.client?.notify(REQUEST_SNAPSHOT_CMD)
  }

  private onEvent(e: ControlEvent): void {
    if (!isWorldEvent(e)) return
    if (e.event === WORLD_EVENT.snapshot) {
      const snap = e as WorldSnapshotEvent
      this.lastWorld = snap.world
      this.opts.onSnapshot(this.opts.instanceId, snap.world)
      return
    }
    if (e.event === WORLD_EVENT.patch) {
      const p = e as WorldPatchEvent
      if (!this.lastWorld || p.baseVersion !== this.lastWorld.version) {
        this.requestSnapshot()
        return
      }
      const merged = applyWorldPatch(this.lastWorld, p.patch)
      merged.version = p.version
      this.lastWorld = merged
      this.opts.onSnapshot(this.opts.instanceId, merged)
      return
    }
  }

  close(): void {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    this.offEvent?.()
    this.offEvent = null
    try {
      this.client?.close()
    } catch {
    }
    this.client = null
  }
}
