import { censusTrack } from '@shared/census'

interface ScrollOffset {
  readonly top: number
  readonly left: number
}

interface ViewHost {
  readonly el: HTMLDivElement
  readonly offsets: Map<Element, ScrollOffset>
  slot: HTMLElement | null
}

export interface ViewLifecycle {
  readonly mounts: number
  readonly unmounts: number
  readonly attaches: number
  readonly parks: number
}

type LifecycleCounts = { -readonly [K in keyof ViewLifecycle]: number }

const hosts = new Map<string, ViewHost>()
censusTrack('view-host-registry.hosts', hosts)
const lifecycles = new Map<string, LifecycleCounts>()
censusTrack('view-host-registry.lifecycles', lifecycles)
const released: string[] = []
const RELEASED_KEPT = 16

let parking: HTMLDivElement | null = null
function getParking(): HTMLDivElement {
  if (!parking || !parking.isConnected) {
    parking = document.createElement('div')
    parking.dataset.viewParking = ''
    parking.style.cssText =
      'position:absolute;left:-99999px;top:0;width:800px;height:600px;overflow:hidden;visibility:hidden;'
    document.body.appendChild(parking)
  }
  return parking
}

function lifecycleOf(id: string): LifecycleCounts {
  let entry = lifecycles.get(id)
  if (!entry) {
    entry = { mounts: 0, unmounts: 0, attaches: 0, parks: 0 }
    lifecycles.set(id, entry)
  }
  return entry
}

function record(host: ViewHost, target: Element): void {
  const top = target.scrollTop
  const left = target.scrollLeft
  if (top === 0 && left === 0) host.offsets.delete(target)
  else host.offsets.set(target, { top, left })
}

function hostOf(id: string): ViewHost {
  const existing = hosts.get(id)
  if (existing) return existing
  const el = document.createElement('div')
  el.dataset.viewHost = id
  el.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;'
  const host: ViewHost = { el, offsets: new Map(), slot: null }
  el.addEventListener(
    'scroll',
    (e) => {
      if (host.slot && e.target instanceof Element) record(host, e.target)
    },
    true
  )
  hosts.set(id, host)
  getParking().appendChild(el)
  return host
}

function prune(host: ViewHost): void {
  for (const target of [...host.offsets.keys()]) {
    if (!host.el.contains(target)) host.offsets.delete(target)
  }
}

function capture(host: ViewHost): void {
  prune(host)
  if (host.el.getClientRects().length === 0) return
  const { width, height } = host.el.getBoundingClientRect()
  host.el.style.width = `${width}px`
  host.el.style.height = `${height}px`
  for (const target of [...host.offsets.keys()]) record(host, target)
}

function restore(host: ViewHost): void {
  prune(host)
  for (const [target, { top, left }] of host.offsets) {
    target.scrollTop = top
    target.scrollLeft = left
  }
}

export function getViewHost(id: string): HTMLDivElement {
  return hostOf(id).el
}

export function attachViewHost(id: string, slot: HTMLElement): void {
  const host = hostOf(id)
  if (host.slot && host.slot !== slot) capture(host)
  host.slot = slot
  host.el.style.width = '100%'
  host.el.style.height = '100%'
  if (host.el.parentElement !== slot) slot.appendChild(host.el)
  restore(host)
  lifecycleOf(id).attaches++
}

export function parkViewHost(id: string, slot: HTMLElement): void {
  const host = hosts.get(id)
  if (!host || host.slot !== slot) return
  capture(host)
  host.slot = null
  const park = getParking()
  if (host.el.parentElement !== park) park.appendChild(host.el)
  lifecycleOf(id).parks++
}

export function releaseViewHost(id: string): void {
  const host = hosts.get(id)
  if (!host) return
  host.el.remove()
  host.offsets.clear()
  hosts.delete(id)
  released.push(id)
  while (released.length > RELEASED_KEPT) {
    const old = released.shift() as string
    if (!hosts.has(old)) lifecycles.delete(old)
  }
}

export function noteViewMounted(id: string): void {
  lifecycleOf(id).mounts++
}

export function noteViewUnmounted(id: string): void {
  lifecycleOf(id).unmounts++
}
