import type { ResourceWindowInfo, ResourceWorkspaceInfo, WorkspaceState } from '@shared/api'
import { describeWorkspace, unityOwnerCandidates, workspacePathSets } from '@shared/workspace-topology'

export interface TopologyWindowInput {
  id: string
  label: string
  focused: boolean
  workspace?: WorkspaceState
}

export interface TerminalAttribution {
  windowId: string
  workspaceId: string
  label: string
}

export interface UnityAttribution {
  windowId: string
  workspaceId: string
  primaryPaths: Set<string>
  fallbackPaths: Set<string>
}

export interface WindowTopology {
  windows: ResourceWindowInfo[]
  ptyToWorkspace: Map<string, TerminalAttribution>
  unityCandidates: UnityAttribution[]
}

export function buildWindowTopology(inputs: TopologyWindowInput[]): WindowTopology {
  const windows: ResourceWindowInfo[] = []
  const ptyToWorkspace = new Map<string, TerminalAttribution>()
  const unityCandidates: UnityAttribution[] = []

  for (const input of inputs) {
    const state = input.workspace
    const workspaces: ResourceWorkspaceInfo[] = []

    for (const ws of state?.workspaces ?? []) {
      workspaces.push(describeWorkspace(ws))

      const { primary, fallback } = workspacePathSets(
        ws,
        (state?.worktreesByWorkspace[ws.id] ?? []).map((wt) => wt.path)
      )
      unityCandidates.push({
        windowId: input.id,
        workspaceId: ws.id,
        primaryPaths: primary,
        fallbackPaths: fallback
      })

      for (const tab of state?.tabsByWorkspace[ws.id] ?? []) {
        if (!tab.ptyId) continue
        ptyToWorkspace.set(tab.ptyId, {
          windowId: input.id,
          workspaceId: ws.id,
          label: tab.customLabel || tab.generatedLabel || tab.label || 'Terminal'
        })
      }
    }

    windows.push({ id: input.id, label: input.label, focused: input.focused, workspaces })
  }

  return { windows, ptyToWorkspace, unityCandidates }
}

export function findUnityAttribution(
  candidates: UnityAttribution[],
  projectPath: string | undefined
): UnityAttribution | undefined {
  for (const p of unityOwnerCandidates(projectPath)) {
    const hit =
      candidates.find((c) => c.primaryPaths.has(p)) ?? candidates.find((c) => c.fallbackPaths.has(p))
    if (hit) return hit
  }
  return undefined
}
