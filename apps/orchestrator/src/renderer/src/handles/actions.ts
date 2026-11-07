import { useAppStore } from '../store'
import { leafIds, panelActions, toWire } from '../lib/actions/action-tree'
import { desktopTree } from '../lib/actions/desktop-actions'
import { findTabIn } from '../lib/actions/tab-actions'
import { defineHandle } from './registry'

defineHandle({
  name: 'actions.tree',
  side: 'renderer',
  description:
    "Reads the action descriptors this window has for a tab (tab id; default the focused tab): the panel's own actions registered by its mounted components, then the tab, New session and Workspace menus. These are the same descriptors the toolbar buttons and the phone's menus run. Returns { tab, kind, panel: ids, desktop: ids, all: ids, tree } with leaf ids; diff all against the phone's tree (strip its l: and d: prefixes) to check parity.",
  params: { tab: '' },
  async run(p) {
    const s = useAppStore.getState()
    let tabId = String(p.tab || '')
    if (!tabId) {
      const ws = s.activeWorkspaceId ?? ''
      tabId = (s.groupsByWorkspace[ws] ?? []).find((g) => g.id === s.activeGroupIdByWorkspace[ws])?.activeTabId ?? ''
    }
    const found = findTabIn(s, tabId)
    if (!found) throw new Error(`No tab ${tabId}`)
    const panel = toWire([...panelActions(found.tab.id), ...panelActions(found.tab.ptyId)])
    const desktop = toWire(await desktopTree(found.tab.id))
    const panelIds = leafIds(panel)
    const desktopIds = leafIds(desktop)
    return { tab: tabId, kind: found.tab.contentType, panel: panelIds, desktop: desktopIds, all: [...panelIds, ...desktopIds], tree: [...panel, ...desktop] }
  }
})
