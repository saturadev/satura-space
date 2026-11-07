import { linesSince, logCursor, readTail, selectLines, unityEditorLogPath } from '../satura-exec/logs'
import { currentMark, defineHandle, parseMark } from './registry'
import { primaryOf } from './unity'

function pick(lines: string[], tail: number, grep: string): string[] {
  const text = selectLines(lines, { tail, ...(grep ? { grep } : {}) })
  return text ? text.split('\n') : []
}

defineHandle({
  name: 'logs.since',
  side: 'main',
  description:
    "Reads the app logs written since mark: main process lines, the window console and, when editor is true, the tail of the Unity editor log. Every handle result carries a mark, so logs.since({ mark }) after a handle shows what happened since that call. Without a mark it returns the last tail lines. grep keeps only lines containing that text. Returns { mark, main, window, editor }, where mark is the new mark to pass next time.",
  params: { mark: '', tail: 200, grep: '', editor: false },
  async run(p, ctx) {
    const tail = Math.min(2000, Math.max(1, Number(p.tail) || 200))
    const grep = String(p.grep ?? '')
    const cursor = parseMark(p.mark) ?? { main: 0, console: 0, window: ctx.window }
    const since = linesSince(cursor.window === null && ctx.window !== null ? { ...cursor, window: ctx.window } : cursor)
    const primary = p.editor ? primaryOf(ctx.projectRoot) : null
    return {
      mark: currentMark(ctx.window),
      main: pick(since.main, tail, grep),
      window: pick(since.console, tail, grep),
      ...(p.editor ? { editor: primary ? pick(readTail(unityEditorLogPath(primary.project)), tail, grep) : [] } : {}),
      ...(cursor.main > logCursor(null).main ? { note: 'The mark is newer than the log: the app was restarted since.' } : {})
    }
  }
})
