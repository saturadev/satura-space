export function normalizeProjectPath(projectPath: string): string {
  return projectPath.replace(/[\\/]+$/, '')
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function primaryWorldId(projectPath: string): string {
  const norm = normalizeProjectPath(projectPath)
  return `p${fnv1a(norm)}${norm.length.toString(36)}`
}
