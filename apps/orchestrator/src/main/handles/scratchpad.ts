import { unityProvider } from '../unity/unity-instance-provider'
import { scratchpads } from '../unity/scratchpads'
import { surfaceSnapshot } from '../unity/shared-surface'
import { defineHandle, TEST_PROJECT } from './registry'

defineHandle({
  name: 'scratchpad.main',
  side: 'main',
  description:
    "Reads the main side of the project's scratchpads: each one's id, name, status, lifecycle and pid as scratchpads.list reports them, which session ids each running editor streams to, and which editor each session id is bound to, and the shared video surfaces each editor has imported with the webContents ids every slot was sent to. It also returns, per editor, the frame holds the app last sent to Unity (the slots still on screen or in a recording, and the newest frame every viewer has seen) and how many late frame notices it dropped. Returns { list, sessions, instances, surfaces, holds }.",
  params: {},
  async run(_p, ctx) {
    const list = await scratchpads.list(ctx.projectRoot || TEST_PROJECT)
    return { list: list.map((s) => ({ id: s.id, name: s.name, status: s.status, lifecycle: s.lifecycle, pid: s.pid, path: s.path })), ...unityProvider.subscriptions(), surfaces: surfaceSnapshot(), holds: unityProvider.frameHolds() }
  }
})
