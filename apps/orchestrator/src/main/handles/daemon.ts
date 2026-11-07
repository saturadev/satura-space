import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  getDaemonInitError,
  getDaemonLogPath,
  getDaemonProvider,
  getOwnDaemonBuildId,
  reapOrphanSessions,
  restartDaemon
} from '../daemon/daemon-init'
import { parseDaemonRuntimeFileName } from '../daemon/daemon-spawner'
import { defineHandle } from './registry'

function runtimeFiles(dir: string): Record<string, unknown>[] {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => parseDaemonRuntimeFileName(name))
    .sort()
    .map((name) => {
      const info = parseDaemonRuntimeFileName(name)!
      let pid: unknown = null
      if (info.kind === 'pid') {
        try {
          pid = JSON.parse(readFileSync(`${dir}/${name}`, 'utf8'))
        } catch {
        }
      }
      return { name, ...info, ...(pid ? { pidFile: pid } : {}) }
    })
}

function logTail(path: string, lines: number): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-lines)
}

defineHandle({
  name: 'daemon.status',
  side: 'main',
  description:
    "Reads the terminal daemon state: whether a provider is up, the last init error, this app's daemon build id, the daemon runtime files (sockets, tokens, pid files with pid and build id), the sessions the daemon owns, the sessions this app has attached, old daemons kept only for their sessions, kills waiting for a retry, and the last lines of the daemon log. logLines picks how many log lines.",
  params: { logLines: 20 },
  async run(p) {
    const provider = getDaemonProvider()
    const logPath = getDaemonLogPath()
    const sessions = provider ? await provider.listSessions().catch((e: Error) => `error: ${e.message}`) : null
    return {
      provider: !!provider,
      initError: getDaemonInitError(),
      ownBuildId: getOwnDaemonBuildId(),
      files: runtimeFiles(dirname(logPath)),
      sessions: Array.isArray(sessions) ? sessions.map((s) => ({ id: s.sessionId, pid: s.pid })) : sessions,
      attached: provider?.getActiveSessionIds() ?? [],
      legacy: provider?.getLegacyDaemons() ?? [],
      pendingKills: provider?.getPendingKills() ?? [],
      logPath,
      log: logTail(logPath, Math.max(0, Number(p.logLines ?? 20)))
    }
  }
})

defineHandle({
  name: 'daemon.restart',
  side: 'main',
  description:
    'Restarts the terminal daemon the way Settings > Restart daemon does, without the confirm: every terminal gets an exit event and a fresh daemon starts. Works when the daemon never started. Returns killedCount, or throws the start error.',
  params: {},
  async run() {
    return restartDaemon()
  }
})

defineHandle({
  name: 'daemon.reapOrphans',
  side: 'main',
  description:
    'Runs the startup orphan check now: kills every daemon session that no window tab references and this app has not attached. Returns the killed session ids.',
  params: {},
  async run() {
    return { killed: await reapOrphanSessions() }
  }
})
