import { ipcMain } from 'electron'
import type { AgentId } from '@shared/types'
import { detectInstalledAgents } from '../agents/agent-path-detection'

export function registerAgentHandlers(): void {
  ipcMain.handle('agents:detect', (): AgentId[] => detectInstalledAgents())
}
