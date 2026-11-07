import { DaemonServer, type DaemonServerOptions } from './daemon-server'

export type DaemonStartOptions = {
  socketPath: string
  tokenPath: string
  buildId?: string
  spawnSubprocess: DaemonServerOptions['spawnSubprocess']
  onShutdownRequested?: DaemonServerOptions['onShutdownRequested']
}

export type DaemonHandle = {
  shutdown(): Promise<void>
}

export async function startDaemon(opts: DaemonStartOptions): Promise<DaemonHandle> {
  const server = new DaemonServer({
    socketPath: opts.socketPath,
    tokenPath: opts.tokenPath,
    buildId: opts.buildId,
    spawnSubprocess: opts.spawnSubprocess,
    onShutdownRequested: opts.onShutdownRequested
  })

  await server.start()

  return {
    shutdown: () => server.shutdown()
  }
}
