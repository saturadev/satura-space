import { isAbsolute, join, resolve } from 'node:path'
import type { Settings } from '@shared/types'

const GIT_SCM = 'getState log getCommit getMergeBase diffBetweenWithStats diffBetween patch explainDiff diffStats compareCommits compareCommitsStats show showImage revealInFolder add revert stageContent discardOutsideEnv discardEnvLines rm commit fetch pull push cancelRemote rebaseAbort clean mergeAbort stash stashApply stashPop stashDrop stashShow writeFile trackedPaths addToGitignore updateNeverCommit keepEnv getSettings setSettings watch unwatch'
const TUNER = 'listViews watchViews unwatchViews canvases writeQuickView addObject start stop refresh camera edit transform open close button select reset save discard discardScene saveScene newScene particles animator staging hierarchy canvasView watch tree pick clearView pickRect rect rects handles sceneSelection theme sceneSettings annotations visibility attach mirror driftAnswer'
const UNITY = 'startHub stop restart stopProject refresh revealEditor hideEditor isEditorRevealed stepFrame getMode setMode closeExternalEditor lifecycle retry cancel answerDialog watchLifecycle unwatchLifecycle setHotReload setDesired getWorld isProject getRecentScenes setLastScene removeRecentScene getConsolePrefs setConsolePrefs getRemotePrefs setRemotePrefs getStreamResolutions setStreamResolutions instanceDir players console:subscribe console:unsubscribe'

const prefixed = (prefix: string, names: string): string[] => names.split(' ').map((n) => `${prefix}:${n}`)

const PHONE_CHANNELS: ReadonlySet<string> = new Set([
  'app:getVersion',
  'app:isDev',
  'app:openFile',
  'app:compileReport',
  'app:listReports',
  'app:reportAction',
  'app:reportDiag',
  'app:reportCodeRefs',
  'app:reportReadCode',
  'app:reportStat',
  'app:reportInfo',
  'app:reportExportScan',
  'auth:configured',
  'auth:get-session',
  'settings:get',
  'settings:set',
  'agents:detect',
  'picker:places',
  'fs:readDir',
  'fs:readFile',
  'fs:readFileFrom',
  'fs:statPath',
  'fs:writeFile',
  'fs:listFiles',
  'fs:search:start',
  'fs:search:cancel',
  'fs:createFile',
  'fs:createDir',
  'fs:rename',
  'fs:trash',
  'fs:duplicate',
  'fs:watch:start',
  'fs:watch:stop',
  'ui:writeClipboardText',
  'shell:openPath',
  'shell:showItemInFolder',
  'shell:openExternal',
  'system:load',
  'claudeUsage:getRemaining',
  'codexUsage:getRemaining',
  'kimiUsage:getRemaining',
  'usage:snapshot',
  'git:listIgnored',
  'git:blame',
  'git:isTracked',
  'git:isRepo',
  ...prefixed('gitScm', GIT_SCM),
  'pty:spawn',
  'pty:write',
  'pty:resize',
  'pty:kill',
  'pty:agentStates',
  ...prefixed('unity', UNITY),
  ...prefixed('tuner', TUNER),
  ...prefixed('tunerInspector', 'open input resize capture close fonts'),
  'tunerPopup:objects',
  ...prefixed('scratchpads', 'attach list create rename start stop restart remove'),
  'agent-exec:tell',
  'rvideo:signal',
  ...prefixed('dashboard', 'load edit state fetch abort handle git logs file watch unwatch alerts alertSent'),
  'plugin:call',
  'plugin:project'
])

export const PHONE_SETTINGS: readonly (keyof Settings)[] = ['unityPlayerVolume', 'unityPlayerMuted', 'reportZoom', 'terminalFontSize', 'editorFontSize']

export type PathUse = 'read' | 'write' | 'media'

export interface PhoneCallContext {
  inside: (path: string, use: PathUse) => boolean
  ptyExists: (id: string) => boolean
  settings: () => Settings
}

export type PhoneVerdict = { ok: true; args: unknown[] } | { ok: false; reason: string; path?: string; blocked?: true }

interface PathNeed {
  need: unknown[]
  may?: unknown[]
  use?: PathUse
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

export function attachPath(req: unknown): string | null {
  const { root, id, ext } = obj(req)
  if (typeof root !== 'string' || !isAbsolute(root) || typeof id !== 'string' || !/^[a-z0-9]{8,40}$/.test(id) || (ext !== 'png' && ext !== 'jpg')) return null
  return join(root, '.sspace', 'attachments', `${id}.${ext}`)
}

const under = (root: unknown, p: unknown): unknown =>
  typeof p === 'string' && p && !isAbsolute(p) && typeof root === 'string' && isAbsolute(root) ? resolve(root, p) : p

const READS = new Set(['fs:readDir', 'fs:readFile', 'fs:readFileFrom', 'fs:statPath', 'fs:listFiles', 'fs:watch:start', 'git:isRepo', 'git:listIgnored'])

function pathsOf(ch: string, args: unknown[]): PathNeed | null {
  const [a0, a1, a2] = args
  if (READS.has(ch)) return { need: [ch === 'fs:watch:start' ? obj(a0).filePath : a0], use: 'read' }
  switch (ch) {
    case 'fs:writeFile':
      return { need: [obj(a0).filePath], use: 'write' }
    case 'fs:search:start':
      return { need: [obj(a1).rootPath], use: 'read' }
    case 'fs:createFile':
    case 'fs:createDir':
    case 'fs:trash':
    case 'fs:duplicate':
      return { need: [a0], use: 'write' }
    case 'fs:rename':
      return { need: [obj(a0).oldPath, obj(a0).newPath], use: 'write' }
    case 'shell:openPath':
    case 'shell:showItemInFolder':
      return { need: [a0], use: 'read' }
    case 'app:openFile': {
      const r = obj(a0)
      return { need: [under(r.projectPath, r.file)], may: [r.projectPath], use: 'read' }
    }
    case 'app:compileReport':
    case 'app:reportCodeRefs':
    case 'app:reportReadCode':
    case 'app:reportInfo':
      return { need: [a0], may: [a1], use: 'read' }
    case 'app:reportAction':
      return { need: [a0], may: [a2], use: 'read' }
    case 'app:reportStat':
      return { need: [a0], may: [a1], use: 'read' }
    case 'app:listReports':
    case 'app:reportExportScan':
      return { need: [a0], use: 'read' }
    case 'git:blame':
    case 'git:isTracked': {
      const r = obj(a0)
      return { need: [r.rootPath], may: [under(r.rootPath, r.filePath)], use: 'read' }
    }
    case 'gitScm:writeFile':
    case 'gitScm:revealInFolder':
      return { need: [a0, under(a0, a1)], use: 'write' }
    case 'dashboard:watch':
      return { need: [a1], use: 'read' }
    case 'plugin:call':
      return { need: [a2], use: 'write' }
    case 'plugin:project':
      return { need: [a0], use: 'read' }
    case 'dashboard:abort':
    case 'dashboard:unwatch':
      return null
    case 'remote:attach':
      return { need: [attachPath(a0)], use: 'write' }
    case 'remote:readMedia':
    case 'remote:videoPlan':
    case 'remote:videoStill':
    case 'remote:mediaStop':
      return { need: [obj(a0).path], may: [obj(obj(a0).report).file], use: 'media' }
    case 'remote:storeAction': {
      const req = obj(a0)
      const inner = Array.isArray(req.args) ? req.args : []
      if (req.action === 'openFile') {
        const r = obj(inner[0])
        return { need: [under(r.projectPath, r.file)], may: [r.projectPath], use: 'read' }
      }
      if (req.action === 'fileVersions') return { need: [obj(inner[1]).file], use: 'write' }
      return null
    }
  }
  if (ch.startsWith('gitScm:') || ch.startsWith('dashboard:')) return { need: [a0], use: ch.startsWith('gitScm:') ? 'write' : 'read' }
  if (/^(unity|tuner|tunerInspector|tunerPopup|scratchpads):/.test(ch) && 'projectPath' in obj(a0)) return { need: [obj(a0).projectPath], use: 'write' }
  return null
}

function vetPaths(ch: string, args: unknown[], ctx: PhoneCallContext): PhoneVerdict | null {
  const spec = pathsOf(ch, args)
  if (!spec) return null
  const use = spec.use ?? 'read'
  for (const p of spec.need) {
    if (typeof p !== 'string' || !p || !isAbsolute(p)) return { ok: false, reason: `${ch} needs an absolute path`, path: String(p ?? '') }
    if (!ctx.inside(p, use)) return { ok: false, reason: `${p} is outside the folders open on the desktop`, path: p }
  }
  for (const p of spec.may ?? []) {
    if (p === undefined || p === null || p === '') continue
    if (typeof p !== 'string' || !isAbsolute(p) || !ctx.inside(p, use)) return { ok: false, reason: `${String(p)} is outside the folders open on the desktop`, path: String(p) }
  }
  return null
}

const PTY_BY_ID = new Set(['pty:spawn', 'pty:write', 'pty:resize', 'pty:kill'])
const DESKTOP_ONLY_CHANNELS = new Set(['remote:pairedPhones', 'remote:forgetPhone', 'remote:forgetAllPhones', 'remote:newKeys', 'remote:newPairCode', 'remote:pairInfo', 'remote:pairAsks', 'remote:answerPair', 'remote:setRestorePrompts'])

function phoneSettings(stored: Settings, incoming: unknown): Settings {
  const next = { ...stored } as Record<string, unknown>
  const from = obj(incoming)
  for (const key of PHONE_SETTINGS) {
    const v = from[key]
    const was = (stored as unknown as Record<string, unknown>)[key]
    if (v === undefined) continue
    if (typeof v === 'number' ? Number.isFinite(v) && (was === undefined || typeof was === 'number') : typeof v === 'boolean' && (was === undefined || typeof was === 'boolean')) next[key] = v
  }
  return next as unknown as Settings
}

export function vetPhoneCall(ch: string, args: unknown[], ctx: PhoneCallContext): PhoneVerdict {
  if (DESKTOP_ONLY_CHANNELS.has(ch)) return { ok: false, reason: `${ch} only runs on the desktop`, blocked: true }
  const remoteOwn = ch.startsWith('remote:')
  if (!remoteOwn && !PHONE_CHANNELS.has(ch)) return { ok: false, reason: `${ch} is not open to the phone`, blocked: true }
  if (PTY_BY_ID.has(ch)) {
    const id = obj(args[0]).id
    if (typeof id !== 'string' || !id || !ctx.ptyExists(id)) return { ok: false, reason: 'That terminal is not running on the desktop' }
  }
  const paths = vetPaths(ch, args, ctx)
  if (paths) return paths
  if (ch === 'settings:set') return { ok: true, args: [phoneSettings(ctx.settings(), args[0])] }
  return { ok: true, args }
}
