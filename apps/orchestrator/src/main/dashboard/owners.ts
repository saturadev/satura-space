import { cleanProject } from './files'

const owners = new Map<string, string>()

export function setDashboardOwner(project: string, paneKey: string): void {
  if (paneKey) owners.set(cleanProject(project), paneKey)
}

export function dashboardOwner(project: string): string | null {
  return owners.get(cleanProject(project)) ?? null
}

export function dashboardProjectOf(file: string): string | null {
  const f = file.replace(/\\/g, '/')
  const i = f.indexOf('/.sspace/dashboard/')
  return i > 0 ? f.slice(0, i) : null
}
