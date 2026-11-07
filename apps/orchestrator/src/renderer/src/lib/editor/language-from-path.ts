
const BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  xml: 'xml',
  svg: 'xml',
  unity: 'yaml',
  prefab: 'yaml',
  asset: 'yaml',
  mat: 'yaml',
  meta: 'yaml',
  shader: 'plaintext',
  cginc: 'plaintext',
  hlsl: 'plaintext',
  compute: 'plaintext'
}

const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'plaintext',
  '.gitignore': 'plaintext',
  '.env': 'plaintext'
}

export function languageFromPath(filePath: string): string {
  const base = filePath.replace(/[\\/]+$/g, '').split(/[\\/]/).at(-1) ?? ''
  const lower = base.toLowerCase()
  if (BY_NAME[lower]) return BY_NAME[lower]
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot + 1) : ''
  return BY_EXT[ext] ?? 'plaintext'
}
