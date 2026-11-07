type Rpc = (method: string, params: Record<string, unknown>) => Promise<unknown>
type Options = Record<string, unknown>
type Answer = { value: unknown; images?: number[] }

export function known(options: Options, name: string, allowed: string[]): Options {
  const extra = Object.keys(options).filter((k) => !allowed.includes(k))
  if (extra.length) throw new TypeError(`${name}: unknown option ${extra.join(', ')}. Options: ${allowed.join(', ')}.`)
  return options
}

export function opts(raw: unknown, name: string, allowed?: string[]): Options {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name}: options go in an object, like { timeout: 120 }`)
  return allowed ? known(raw as Options, name, allowed) : (raw as Options)
}

export function kindOf(v: unknown): string {
  if (Array.isArray(v)) return 'an array'
  if (typeof v === 'function') return 'a function'
  return 'an object'
}

export function text(v: unknown, what: string): string {
  if ((typeof v === 'object' && v !== null) || typeof v === 'function') throw new TypeError(`${what}, got ${kindOf(v)}`)
  return v === undefined || v === null ? '' : String(v)
}

function plain(v: unknown): v is Options {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
}

function base(path: unknown): string {
  return String(path ?? '').split(/[\\/]/).pop() ?? ''
}

function regex(grep: unknown): unknown {
  return grep instanceof RegExp ? { source: grep.source, flags: grep.flags } : grep
}

function paths(raw: unknown, what: string): string[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
  return list.map((p) => text(p, `${what} takes paths as strings or a list of strings`))
}

function runId(v: unknown, what: string): number {
  const raw = plain(v) && 'run' in v ? v.run : v
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN
  if (Number.isInteger(n) && n > 0) return n
  const got = raw === undefined ? 'nothing' : (typeof raw === 'object' && raw !== null) || typeof raw === 'function' ? kindOf(raw) : String(raw)
  throw new TypeError(`${what} takes the run id that handles.call(name, { wait: false }) returned, like ${what.replace('()', '(3)')}, got ${got}`)
}

function withImages(a: Answer): unknown {
  if (!a.images?.length) return a.value
  const tag = a.images.length === 1 ? `image ${a.images[0]}` : `images ${a.images.join(', ')}`
  return `${String(a.value ?? '').trim()}\n(${tag} attached to the reply)`
}

type CameraReply = { ok: boolean; error: string; state: string; note: string; frames: number; seconds: number; gameSeconds: number; wallSeconds: number; fps: number; width: number; height: number; clips: { name: string; path: string }[] }
type CameraVideo = { paths: string[]; names: string[]; frames: number; seconds: number; wallSeconds: number; fps: number; size: string; note?: string }

const CAMERA_STALL_MS = 30_000
const CAMERA_POLL_MS = 250

function csString(s: string): string {
  return `@"${s.replace(/"/g, '""')}"`
}

function vec(v: unknown, what: string): number[] {
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n))) throw new TypeError(`${what} is [x, y, z], got ${JSON.stringify(v)}`)
  return v as number[]
}

function cameraSize(size: unknown): { width: number; height: number } {
  if (size === undefined || size === null || size === '') return { width: 1280, height: 720 }
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(String(size).trim())
  if (!m) throw new TypeError(`video.cameras(): size is "WIDTHxHEIGHT" like "1280x720", got ${JSON.stringify(size)}`)
  return { width: Number(m[1]), height: Number(m[2]) }
}

function cameraList(raw: unknown): Options[] {
  const list = Array.isArray(raw) ? raw : [raw]
  if (!list.length) throw new TypeError('video.cameras(): pass one camera or a list of them')
  return list.map((c, i) => {
    const where = `video.cameras() camera ${i + 1}`
    if (!plain(c)) throw new TypeError(`${where} is an object like { name, position, lookAt }`)
    const k = known(c, where, ['name', 'position', 'rotation', 'lookAt', 'follow', 'fov'])
    const lookAt = k.lookAt
    return {
      name: k.name === undefined ? '' : text(k.name, `${where}: name is a string`),
      position: k.position === undefined ? [] : vec(k.position, `${where}: position`),
      rotation: k.rotation === undefined ? [] : vec(k.rotation, `${where}: rotation`),
      lookAt: lookAt === undefined || typeof lookAt === 'string' ? [] : vec(lookAt, `${where}: lookAt`),
      lookAtObject: typeof lookAt === 'string' ? lookAt : '',
      follow: k.follow === undefined ? '' : text(k.follow, `${where}: follow is an object path`),
      fov: k.fov === undefined ? 0 : Number(k.fov)
    }
  })
}

export function unityApis(rpc: Rpc, project = ''): { unity: Options; handles: Options; video: Options; scratchpad: Options; env: Options } {
  const mcp = (fn: string, args: Options, label?: string, graphics?: string): Promise<Answer> =>
    rpc('mcp', { fn, args: project ? { ...args, project } : args, label: label ?? fn, ...(graphics ? { graphics } : {}) }) as Promise<Answer>
  const value = async (fn: string, args: Options, label?: string, graphics?: string): Promise<unknown> => (await mcp(fn, args, label, graphics)).value

  const handles = {
    list: (filter?: unknown, o?: unknown) => value('handles.list', { filter: text(filter, 'handles.list() takes a filter string'), player: opts(o, 'handles.list()', ['player']).player }),
    call: (name: unknown, ...rest: unknown[]) => {
      const o = rest.length && plain(rest[rest.length - 1]) ? known(rest.pop() as Options, 'handles.call()', ['player', 'wait', 'timeout', 'at']) : {}
      const n = text(name, "handles.call() takes the handle's name as a string")
      return value('handles.call', { name: n, args: rest, player: o.player, wait: o.wait, timeout: o.timeout, at: o.at }, `handles.call ${n}${o.player ? ` (${String(o.player)})` : ''}`)
    },
    result: (run: unknown, o?: unknown) => {
      const id = runId(run, 'handles.result()')
      return value('handles.result', { run: id, ...opts(o, 'handles.result()', ['wait', 'timeout', 'player']) }, `handles.result ${id}`)
    },
    stop: (run: unknown, o?: unknown) => {
      const id = runId(run, 'handles.stop()')
      return value('handles.stop', { run: id, ...opts(o, 'handles.stop()', ['player']) }, `handles.stop ${id}`)
    }
  }

  const videoOp = (op: string, args: Options = {}, label?: string) => value('video', { op, ...args }, label ?? `video.${op === 'clear_buffer' ? 'clear' : op}`, op === 'start' ? 'video.start()' : undefined)
  const finish = async (o?: unknown): Promise<string> => {
    const { path, player } = opts(o, 'video.finish()', ['path', 'player'])
    const text = String(await videoOp('finish', { path, player }))
    const saved = /^Saved (.+)$/m.exec(text)
    return saved ? saved[1].trim() : text
  }
  const video = {
    start: (o?: unknown) => {
      const { size, audio, player } = opts(o, 'video.start()', ['size', 'audio', 'player'])
      return videoOp('start', { size: size === undefined ? undefined : String(size), audio, player })
    },
    stop: (o?: unknown) => videoOp('stop', { player: opts(o, 'video.stop()', ['player']).player }),
    finish,
    clear: (o?: unknown) => videoOp('clear_buffer', { player: opts(o, 'video.clear()', ['player']).player }),
    status: (o?: unknown) => videoOp('status', { player: opts(o, 'video.status()', ['player']).player }),
    async record(run: unknown, o?: unknown): Promise<string> {
      if (typeof run !== 'function') throw new TypeError('video.record(async () => { ... }, options): pass the steps to film as a function')
      const { path, ...start } = opts(o, 'video.record()', ['size', 'audio', 'player', 'path'])
      await video.clear({ player: start.player })
      await video.start(start)
      try {
        await (run as () => unknown)()
      } finally {
        await video.stop({ player: start.player })
      }
      return finish({ path, player: start.player })
    },
    async cameras(list: unknown, run: unknown, o?: unknown): Promise<CameraVideo> {
      if (typeof run !== 'function') throw new TypeError('video.cameras(cameras, async () => { ... }, options): pass the steps to film as a function')
      const { size, fps, folder, player, seconds } = opts(o, 'video.cameras()', ['size', 'fps', 'folder', 'player', 'seconds'])
      const { width, height } = cameraSize(size)
      const want = seconds === undefined ? 0 : Number(seconds)
      if (!Number.isFinite(want) || want < 0 || want > 600) throw new TypeError(`video.cameras(): seconds is the game time to film, from 0 to 600, got ${JSON.stringify(seconds)}`)
      const payload = { cameras: cameraList(list), width, height, fps: fps === undefined ? 30 : Number(fps), seconds: want, folder: folder === undefined ? '' : text(folder, 'video.cameras(): folder is a path') }
      const cam = async (call: string, label: string): Promise<CameraReply> => {
        const out = String(await value('unity.exec', { code: `Print(MCPTestBridge.${call});`, player }, label, 'video.cameras()'))
        const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)
        try {
          return JSON.parse(json) as CameraReply
        } catch {
          throw new Error(`${label}: unexpected reply from Unity: ${out.slice(0, 300)}`)
        }
      }
      const begun = await cam(`CameraVideoStart(${csString(JSON.stringify(payload))})`, `video.cameras start (${payload.cameras.length})`)
      if (!begun.ok) throw new Error(`video.cameras(): ${begun.error}`)
      try {
        await (run as () => unknown)()
      } catch (e) {
        await cam('CameraVideoStop()', 'video.cameras stop').catch(() => null)
        throw e
      }
      if (want > 0) {
        let frames = -1
        let movedAt = Date.now()
        for (;;) {
          const st = await cam('CameraVideoStatus()', 'video.cameras wait')
          if (st.state !== 'recording') break
          if (st.frames !== frames) {
            frames = st.frames
            movedAt = Date.now()
          } else if (Date.now() - movedAt > CAMERA_STALL_MS) {
            await cam('CameraVideoStop()', 'video.cameras stop').catch(() => null)
            throw new Error(`video.cameras(): no new frame for ${CAMERA_STALL_MS / 1000} s at ${frames} frames: is the game paused or the editor busy?`)
          }
          await new Promise((r) => setTimeout(r, CAMERA_POLL_MS))
        }
      }
      const done = await cam('CameraVideoStop()', 'video.cameras stop')
      if (!done.ok) throw new Error(`video.cameras(): ${done.error}`)
      return {
        paths: done.clips.map((c) => c.path),
        names: done.clips.map((c) => c.name),
        frames: done.frames,
        seconds: Math.round(done.seconds * 100) / 100,
        wallSeconds: Math.round(done.wallSeconds * 100) / 100,
        fps: done.fps,
        size: `${done.width}x${done.height}`,
        ...(done.note ? { note: done.note } : {})
      }
    }
  }

  type Life = { delegate?: boolean; managed?: boolean; up?: boolean; text?: string }
  const detail = async (): Promise<string> => {
    try {
      return String(((await rpc('mcp', { fn: 'unity.status', args: project ? { project, lifecycle: false } : { lifecycle: false }, label: 'unity.status', quiet: true })) as Answer).value ?? '')
    } catch {
      return ''
    }
  }
  const joined = (head: unknown, more: string): string => (more ? `${String(head ?? '')}\n${more}` : String(head ?? ''))
  const unity = {
    status: async () => {
      const life = (await rpc('unity', { op: 'status', path: project })) as Life
      if (life?.delegate || !life?.managed) return value('unity.status', {})
      return life.up ? joined(life.text, await detail()) : life.text
    },
    exec: (code: unknown, o?: unknown) => {
      const { usings, player, timeout } = opts(o, 'unity.exec()', ['usings', 'player', 'timeout'])
      return value('unity.exec', { code: text(code, 'unity.exec() takes the C# as a string'), usings, player, timeout }, `unity.exec${player ? ` (${String(player)})` : ''}`)
    },
    refresh: (o?: unknown) => value('unity.refresh', opts(o, 'unity.refresh()', ['timeout'])),
    openScene: (scene: unknown, o?: unknown) => value('unity.openScene', { scene: text(scene, 'unity.openScene() takes the scene path as a string'), ...opts(o, 'unity.openScene()', ['play', 'hotReload', 'refresh', 'timeout', 'unsaved']) }, `unity.openScene ${base(scene)}`),
    play: (scene?: unknown, o?: unknown) => {
      const [path, rest] = plain(scene) ? ['', known(scene, 'unity.play()', ['hotReload', 'refresh', 'timeout', 'unsaved'])] : [text(scene, 'unity.play() takes the scene path as a string'), opts(o, 'unity.play()', ['hotReload', 'refresh', 'timeout', 'unsaved'])]
      return value('unity.openScene', { ...rest, scene: path, play: true }, `unity.play${path ? ` ${base(path)}` : ''}`)
    },
    stop: (o?: unknown) => value('unity.stop', opts(o, 'unity.stop()', ['timeout'])),
    logs: (o?: unknown) => {
      const q = opts(o, 'unity.logs()', ['source', 'severity', 'grep', 'lines', 'tag', 'player', 'collapse'])
      return value('unity.logs', { ...q, grep: regex(q.grep) }, `unity.logs${q.source ? ` ${String(q.source)}` : ''}`)
    },
    screenshot: async (poses: unknown, o?: unknown) => withImages(await mcp('unity.screenshot', { poses, ...opts(o, 'unity.screenshot()', ['save', 'timeout']) }, 'unity.screenshot', 'unity.screenshot()')),
    players: () => value('unity.players', {}),
    fps: (o?: unknown) => value('unity.fps', opts(o, 'unity.fps()', ['player'])),
    capFps: (fps: unknown, o?: unknown) => {
      const n = typeof fps === 'number' ? fps : typeof fps === 'string' && fps.trim() ? Number(fps) : Number.NaN
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new TypeError(`unity.capFps() takes frames per second as a whole number from 1 to 1000, like unity.capFps(30), got ${JSON.stringify(fps) ?? String(fps)}. unity.uncapFps() removes the cap.`)
      const { player } = opts(o, 'unity.capFps()', ['player'])
      return value('unity.fps', { cap: n, player }, `unity.capFps ${n}${player ? ` (${String(player)})` : ''}`)
    },
    uncapFps: (o?: unknown) => {
      const { player } = opts(o, 'unity.uncapFps()', ['player'])
      return value('unity.fps', { cap: null, player }, `unity.uncapFps${player ? ` (${String(player)})` : ''}`)
    },
    resolution: (size?: unknown, o?: unknown) => {
      const [want, rest] = plain(size) ? [undefined, known(size, 'unity.resolution()', ['player'])] : [size, opts(o, 'unity.resolution()', ['player'])]
      if (want !== undefined && (typeof want !== 'string' || !/^\s*\d+\s*x\s*\d+\s*$/i.test(want))) throw new TypeError(`unity.resolution() takes the stream size as "WIDTHxHEIGHT", like unity.resolution('1920x1080'), got ${JSON.stringify(want) ?? String(want)}. With no size it reads the current one.`)
      const player = rest.player
      return value('unity.resolution', { size: want === undefined ? undefined : String(want).replace(/\s+/g, ''), player }, `unity.resolution${want ? ` ${String(want)}` : ''}${player ? ` (${String(player)})` : ''}`)
    },
    dialogs: () => value('unity.dialogs', { action: '' }),
    answer: (button: unknown, o?: unknown) => {
      const label = text(button, 'unity.answer() takes the button label as a string')
      return value('unity.dialogs', { action: 'click', button: label, ...opts(o, 'unity.answer()', ['id', 'timeout']) }, `unity.answer ${label}`)
    },
    closeDialog: (id?: unknown) => value('unity.dialogs', { action: 'close', id: text(id, 'unity.closeDialog() takes the dialog id as a string, from unity.dialogs()') }, 'unity.closeDialog'),
    relaunch: async (o?: unknown) => {
      const args = opts(o, 'unity.relaunch()', ['timeout'])
      const life = (await rpc('unity', { op: 'relaunch', path: project, timeout: args.timeout })) as Life
      if (life?.delegate) return value('unity.relaunch', args)
      return life.up ? joined(life.text, await detail()) : life.text
    },
    shutdown: (o?: unknown) => value('unity.shutdown', opts(o, 'unity.shutdown()', ['force', 'timeout'])),
    trace: (object: unknown, o?: unknown) => value('unity.trace', { command: 'start', object: text(object, 'unity.trace() takes the object path as a string'), ...opts(o, 'unity.trace()', ['members', 'seconds', 'player', 'ancestors', 'maxEvents', 'timeout']) }, `unity.trace ${String(object ?? '')}`),
    traceReport: (o?: unknown) => {
      const { stop, ...rest } = opts(o, 'unity.traceReport()', ['stop', 'collapse', 'maxLines', 'player', 'timeout'])
      return value('unity.trace', { command: stop === false ? 'peek' : 'report', ...rest }, 'unity.traceReport')
    },
    source: (mode: unknown, symbol?: unknown, o?: unknown) => {
      const m = text(mode, "unity.source() takes the mode as a string, like 'signatures'")
      const sourceKeys = ['path', 'glob', 'startLine', 'endLine', 'includePrivate', 'maxLines', 'maxMatches', 'context', 'version']
      const rest = plain(symbol) ? known(symbol, 'unity.source()', sourceKeys) : opts(o, 'unity.source()', sourceKeys)
      const s = plain(symbol) ? '' : text(symbol, 'unity.source() takes the symbol as a string')
      return value('unity.source', { mode: m, ...(m === 'grep' ? { pattern: s } : { symbol: s }), ...rest }, `unity.source ${m} ${s}`.trim())
    },
    docs: (api: unknown, o?: unknown) => value('unity.docs', { api: text(api, 'unity.docs() takes the API name as a string'), ...opts(o, 'unity.docs()', ['version']) }, `unity.docs ${String(api ?? '')}`),
    mode: () => rpc('unityMode', { op: 'get', path: project }),
    setMode: (mode: unknown, o?: unknown) => {
      const m = text(mode, "unity.setMode() takes the mode as a string: 'normal', 'headless-graphics' or 'headless-nographics'")
      const { wait, timeout } = opts(o, 'unity.setMode()', ['wait', 'timeout'])
      return rpc('unityMode', { op: 'set', path: project, mode: m, wait, timeout })
    },
    at: (folder: unknown) => {
      const dir = text(folder, 'unity.at() takes a folder path as a string').trim()
      if (!dir) throw new TypeError('unity.at(folder) needs a scratchpad or multiplayer clone folder, from scratchpad.list() or unity.players()')
      if (!/[\\/]/.test(dir)) throw new TypeError(`unity.at() takes a folder path, got ${JSON.stringify(dir)}. For a scratchpad by name or id, use await scratchpad.get(${JSON.stringify(dir)})`)
      const bound = unityApis(rpc, dir)
      return { ...bound.unity, handles: bound.handles, video: bound.video }
    }
  }

  const pad = (command: string, args: Options = {}, label?: string) => value('scratchpad', { command, ...args }, label ?? `scratchpad.${command}`)
  const padWait = (o: unknown, call: string, allowed: string[] = []): Options => {
    const { wait, timeout, ...rest } = opts(o, call, [...allowed, 'wait', 'timeout'])
    const secs = (v: unknown, what: string): number => {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new TypeError(`${call}: ${what} is a number of seconds, got ${String(v)}`)
      return v
    }
    if (timeout !== undefined) return { ...rest, wait: wait === false ? 0 : secs(timeout, 'timeout') }
    if (wait === undefined || wait === true) return rest
    return { ...rest, wait: wait === false ? 0 : secs(wait, 'wait') }
  }
  const padMode = (id: string, mode: unknown, call: string) =>
    rpc('unityMode', { op: 'set', scratchpad: id, mode: text(mode, `${call}: mode is 'normal', 'headless-graphics' or 'headless-nographics'`), wait: false })
  const padId = (id: unknown, call: string): string => text(id, `scratchpad.${call}() takes the scratchpad's id or name as a string, from scratchpad.list()`)
  const copy = (direction: string, id: unknown, list: unknown, o?: unknown) => {
    const pid = padId(id, direction)
    return value('scratchpad.copy', { direction, id: pid, paths: paths(list, `scratchpad.${direction}()`), ...opts(o, `scratchpad.${direction}()`, ['overwrite', 'dependencies']) }, `scratchpad.${direction} ${pid}`)
  }
  const scratchpad = {
    list: () => pad('list'),
    create: async (name: unknown, o?: unknown) => {
      const n = text(name, 'scratchpad.create() takes the name as a string')
      const { mode, ...rest } = padWait(o, 'scratchpad.create()', ['start', 'mode'])
      if (mode === undefined) return pad('create', { name: n, ...rest }, `scratchpad.create ${n}`)
      const made = await pad('create', { name: n, ...rest, start: false }, `scratchpad.create ${n}`)
      await padMode(n, mode, 'scratchpad.create()')
      return rest.start === false ? made : pad('start', { id: n, ...rest }, `scratchpad.start ${n}`)
    },
    start: async (id: unknown, o?: unknown) => {
      const pid = padId(id, 'start')
      const { mode, ...rest } = padWait(o, 'scratchpad.start()', ['mode'])
      if (mode !== undefined) await padMode(pid, mode, 'scratchpad.start()')
      return pad('start', { id: pid, ...rest })
    },
    restart: async (id: unknown, o?: unknown) => {
      const pid = padId(id, 'restart')
      const { mode, ...rest } = padWait(o, 'scratchpad.restart()', ['mode'])
      if (mode === undefined) return pad('restart', { id: pid, ...rest })
      const before = (await rpc('unityMode', { op: 'get', scratchpad: pid })) as { mode?: string }
      await padMode(pid, mode, 'scratchpad.restart()')
      return before.mode === mode ? pad('restart', { id: pid, ...rest }) : pad('start', { id: pid, ...rest })
    },
    stop: (id: unknown, o?: unknown) => pad('stop', { id: padId(id, 'stop'), ...padWait(o, 'scratchpad.stop()') }),
    rename: (id: unknown, name: unknown) => pad('rename', { id: padId(id, 'rename'), name: text(name, 'scratchpad.rename() takes the new name as a string') }),
    remove: (id: unknown) => pad('remove', { id: padId(id, 'remove') }),
    import: (id: unknown, list: unknown, o?: unknown) => copy('import', id, list, o),
    export: (id: unknown, list: unknown, o?: unknown) => copy('export', id, list, o)
  }

  const envCall = (command: string) => (list?: unknown) => value('env', { command, paths: command === 'list' ? undefined : paths(list, `env.${command}()`) }, `env.${command}`)
  const env = {
    list: envCall('list'),
    check: envCall('check'),
    diff: envCall('diff'),
    stage: envCall('stage'),
    add: envCall('add'),
    remove: envCall('remove'),
    keep: envCall('keep')
  }

  return { unity, handles, video, scratchpad, env }
}
