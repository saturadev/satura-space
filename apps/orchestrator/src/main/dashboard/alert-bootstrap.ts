type Config = {
  every?: unknown
  cooldown?: unknown
  to?: unknown
  fetch?: unknown
  handle?: unknown
  git?: unknown
  logs?: unknown
  when?: (data: unknown) => unknown
}

const g = globalThis as unknown as Record<string, unknown>
const send = g.__saturaHost as (json: string) => void
delete g.__saturaHost

let config: Config | null = null
let registered = false

function post(msg: Record<string, unknown>): void {
  send(JSON.stringify(msg))
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    const at = (e.stack ?? '').split('\n').find((l) => /satura_exec\.js:\d+/.test(l))
    return `${e.name}: ${e.message}${at ? `\n${at.trim()}` : ''}`
  }
  return String(e)
}

function plain(v: unknown): unknown {
  if (!v || typeof v !== 'object') return undefined
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return undefined
  }
}

g.__alertRegister = (c: unknown): void => {
  if (registered) return
  registered = true
  delete g.__alertRegister
  const cfg = c as Config | null
  if (!cfg || typeof cfg !== 'object' || typeof cfg.when !== 'function') {
    post({ t: 'bad', message: 'The default export must be alert({ every, fetch | handle | git | logs, when }).' })
    return
  }
  config = cfg
  post({
    t: 'config',
    every: cfg.every,
    cooldown: cfg.cooldown,
    to: cfg.to,
    fetch: plain(cfg.fetch),
    handle: plain(cfg.handle),
    git: plain(cfg.git),
    logs: plain(cfg.logs)
  })
}

g.__saturaDeliver = (json: string): void => {
  const m = JSON.parse(json) as { t?: string; seq?: number; data?: unknown }
  if (m.t !== 'when' || !config?.when) return
  const seq = m.seq
  let out: unknown
  try {
    out = config.when(m.data)
  } catch (e) {
    post({ t: 'result', seq, error: describe(e) })
    return
  }
  Promise.resolve(out).then(
    (v) => post({ t: 'result', seq, value: v === null || v === undefined || v === false || v === '' ? null : String(v) }),
    (e: unknown) => post({ t: 'result', seq, error: describe(e) })
  )
}

g.__saturaStart = (fn: () => unknown): void => {
  Promise.resolve()
    .then(() => fn())
    .then(
      () => post({ t: 'loaded' }),
      (e: unknown) => post({ t: 'bad', message: describe(e) })
    )
}
