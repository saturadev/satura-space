import { startDaemon, type DaemonHandle } from './daemon-main'
import { createPtySubprocess } from './pty-subprocess'
import { computeDaemonBuildId } from './daemon-build-id'
import { installDaemonConsoleLog } from './daemon-log'

const SHUTDOWN_EXIT_GRACE_MS = 1_000

const NATIVE_PTY_ERROR_CODES = new Set(['EIO', 'EPIPE', 'EBADF', 'ENXIO', 'ECONNRESET'])
const NATIVE_PTY_ERROR_MESSAGE =
  /\b(?:EIO|EPIPE|EBADF|ENXIO)\b|ioctl\(2\) failed|forkpty\(3\) failed|openpty\(3\) failed|posix_spawnp? failed|ptsname|pty that has already exited|conpty|winpty|ClosePseudoConsole/i

function isSuppressibleNativePtyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as NodeJS.ErrnoException).code
  if (typeof code === 'string' && NATIVE_PTY_ERROR_CODES.has(code)) return true
  return err.name === 'Error' && NATIVE_PTY_ERROR_MESSAGE.test(err.message ?? '')
}

export function parseArgs(argv: string[]): { socketPath: string; tokenPath: string; logPath: string } {
  let socketPath = ''
  let tokenPath = ''
  let logPath = ''

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--socket' && argv[i + 1]) {
      socketPath = argv[i + 1]
      i++
    } else if (argv[i] === '--token' && argv[i + 1]) {
      tokenPath = argv[i + 1]
      i++
    } else if (argv[i] === '--log' && argv[i + 1]) {
      logPath = argv[i + 1]
      i++
    }
  }

  if (!socketPath || !tokenPath) {
    throw new Error('Usage: daemon-entry --socket <path> --token <path> [--log <path>]')
  }

  return { socketPath, tokenPath, logPath }
}

async function main(): Promise<void> {
  const { socketPath, tokenPath, logPath } = parseArgs(process.argv.slice(2))
  if (logPath) installDaemonConsoleLog(logPath)
  const buildId = computeDaemonBuildId(process.env.SATURA_APP_VERSION ?? '', process.argv[1] ?? __filename)

  process.on('uncaughtException', (err) => {
    if (isSuppressibleNativePtyError(err)) {
      console.error('[daemon] Native PTY exception (suppressed):', err)
      return
    }
    console.error('[daemon] Uncaught exception (fatal):', err)
    throw err
  })

  let daemon: DaemonHandle | null = null

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[daemon] ${signal} received, shutting down`)
    if (daemon) {
      await daemon.shutdown()
      daemon = null
    }
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  daemon = await startDaemon({
    socketPath,
    tokenPath,
    buildId,
    spawnSubprocess: (opts) => createPtySubprocess(opts),
    onShutdownRequested: (done) => {
      console.log('[daemon] shutdown requested by the app')
      daemon = null
      setTimeout(() => process.exit(0), SHUTDOWN_EXIT_GRACE_MS).unref()
      void done.finally(() => process.exit(0))
    }
  })

  console.log(`[daemon] started pid=${process.pid} build=${buildId} socket=${socketPath}`)

  if (process.send) {
    process.send({ type: 'ready', buildId })
  }
}

main().catch((err) => {
  console.error('[daemon] Fatal:', err)
  process.exit(1)
})
