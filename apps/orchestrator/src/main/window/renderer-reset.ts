import type { WebContents } from 'electron'
import { censusTrack } from '@shared/census'

const resetHandlers = new Map<number, Map<string, () => void>>()
censusTrack('renderer-reset.resetHandlers', resetHandlers)

function runAll(wcId: number): void {
  const handlers = resetHandlers.get(wcId)
  if (!handlers) return
  for (const fn of [...handlers.values()]) {
    try {
      fn()
    } catch (err) {
      console.error('[renderer-reset] handler failed', err)
    }
  }
}

export function onRendererReset(wc: WebContents, key: string, fn: () => void): void {
  const wcId = wc.id
  let handlers = resetHandlers.get(wcId)
  if (!handlers) {
    handlers = new Map()
    resetHandlers.set(wcId, handlers)
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) runAll(wcId)
    })
    wc.on('did-navigate', () => runAll(wcId))
    wc.on('render-process-gone', () => runAll(wcId))
    wc.once('destroyed', () => {
      runAll(wcId)
      resetHandlers.delete(wcId)
    })
  }
  handlers.set(key, fn)
}
