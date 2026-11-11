import { registerAppHandlers } from './app'
import { registerSettingsHandlers } from './settings'
import { registerStateHandlers } from './state'
import { registerDialogHandlers } from './dialog'
import { registerFsHandlers } from './fs'
import { registerFsTailHandlers } from './fs-tail'
import { registerPtyHandlers, notifyPtyOwner } from './pty'
import { initDaemonPtyProvider } from '../daemon/daemon-init'
import { initAgentHooks, registerAgentHookHandlers } from '../agent-hooks'
import { onAgentHook, registerAgentAttention } from '../agent-hooks/attention'
import { registerGitHandlers } from './git'
import { registerGitScmHandlers } from './git-scm'
import { registerRecentsHandlers } from './recents'
import { registerWindowHandlers } from './window'
import { registerUnityHandlers } from './unity'
import { registerUnityConsoleHandlers } from './unity-console'
import { registerTunerHandlers } from './tuner'
import { registerTunerInspectorHandlers } from './tuner-inspector'
import { registerTunerPopupHandlers } from './tuner-inspector-popups'
import { registerScratchpadHandlers } from './scratchpads'
import { registerAgentHandlers } from './agents'
import { registerAgentExecHandlers } from '../agent-exec'
import { registerSaturaExec } from '../satura-exec'
import { registerShellHandlers } from './shell'
import { registerResourceHandlers } from './resources'
import { registerClaudeUsageHandlers } from './claude-usage'
import { registerCodexUsageHandlers } from './codex-usage'
import { registerKimiUsageHandlers } from './kimi-usage'
import { registerUsageHandlers } from './usage'
import { registerAuthHandlers } from './auth'
import { registerClaudeSessionHandlers } from './claude-sessions'
import { registerDashboardHandlers } from '../dashboard'
import { registerPluginHandlers } from '../plugins'

export function registerCoreHandlers(): void {
  registerAuthHandlers()
  registerAppHandlers()
  registerSettingsHandlers()
  registerStateHandlers()
  registerDialogHandlers()
  registerFsHandlers()
  registerFsTailHandlers()
  registerPtyHandlers()
  void initDaemonPtyProvider()
  registerAgentAttention()
  registerAgentHookHandlers()
  void initAgentHooks(onAgentHook, (ptyId, info) =>
    notifyPtyOwner(ptyId, 'pty:claude-session', { id: ptyId, ...info })
  )
  registerGitHandlers()
  registerGitScmHandlers()
  registerRecentsHandlers()
  registerWindowHandlers()
  registerUnityHandlers()
  registerUnityConsoleHandlers()
  registerTunerHandlers()
  registerTunerInspectorHandlers()
  registerTunerPopupHandlers()
  registerScratchpadHandlers()
  registerAgentHandlers()
  registerAgentExecHandlers()
  registerPluginHandlers()
  registerSaturaExec()
  registerDashboardHandlers()
  registerShellHandlers()
  registerResourceHandlers()
  registerClaudeUsageHandlers()
  registerCodexUsageHandlers()
  registerKimiUsageHandlers()
  registerUsageHandlers()
  registerClaudeSessionHandlers()
}
