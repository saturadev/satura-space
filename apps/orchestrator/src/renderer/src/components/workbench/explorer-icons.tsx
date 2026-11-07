import {
  AudioLines,
  Blend,
  Box,
  Boxes,
  CodeXml,
  File,
  FileAxis3d,
  FileCode,
  FileCog,
  FileJson,
  FileSliders,
  FileText,
  Film,
  Folder,
  FolderArchive,
  FolderCode,
  FolderCog,
  FolderGit2,
  FolderOpen,
  FolderOutput,
  FolderPen,
  FolderRoot,
  FolderSearch,
  FolderTree,
  Gamepad2,
  Image,
  Images,
  Mountain,
  Package,
  PackageOpen,
  Paintbrush,
  Palette,
  PersonStanding,
  Puzzle,
  SlidersHorizontal,
  Spline,
  Sun,
  Terminal,
  Type,
  Workflow,
  type LucideIcon
} from 'lucide-react'
import { unityAssetKind, type UnityAssetKind } from '@shared/unity-assets'
import { UnitySceneIcon } from '../tuner/unity-icons'

const ROOT_FOLDERS: Record<string, LucideIcon> = {
  Assets: FolderRoot,
  Packages: Package,
  ProjectSettings: FolderCog,
  UserSettings: FolderCog,
  Library: FolderArchive,
  Temp: FolderArchive,
  Logs: FolderArchive,
  obj: FolderArchive,
  Build: FolderArchive,
  Builds: FolderArchive,
  '.git': FolderGit2,
  '.github': FolderGit2
}

const NAMED_FOLDERS: Record<string, LucideIcon> = {
  Editor: FolderPen,
  Scripts: FolderCode,
  Resources: FolderSearch,
  StreamingAssets: FolderOutput,
  Plugins: Puzzle,
  Scenes: FolderTree,
  Prefabs: Boxes
}

const ASSET_ICONS: Record<UnityAssetKind, LucideIcon | typeof UnitySceneIcon> = {
  scene: UnitySceneIcon,
  prefab: Box,
  model: FileAxis3d,
  material: Palette,
  texture: Image,
  audio: AudioLines,
  video: Film,
  anim: Spline,
  controller: Workflow,
  mask: PersonStanding,
  mixer: SlidersHorizontal,
  font: Type,
  lighting: Sun,
  terrain: Mountain,
  atlas: Images,
  timeline: Film,
  data: FileSliders
}

const FILE_ICONS: Record<string, LucideIcon> = {
  cs: FileCode,
  js: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  ts: FileCode,
  tsx: FileCode,
  jsx: FileCode,
  py: FileCode,
  shader: Blend,
  hlsl: Blend,
  cginc: Blend,
  compute: Blend,
  glsl: Blend,
  shadergraph: Blend,
  shadersubgraph: Blend,
  asmdef: FileCog,
  asmref: FileCog,
  json: FileJson,
  inputactions: Gamepad2,
  xml: CodeXml,
  uxml: CodeXml,
  html: CodeXml,
  uss: Paintbrush,
  css: Paintbrush,
  md: FileText,
  txt: FileText,
  yml: FileText,
  yaml: FileText,
  sh: Terminal,
  bat: Terminal,
  ps1: Terminal,
  unitypackage: Package
}

const HIERARCHY_KINDS: ReadonlySet<UnityAssetKind> = new Set(['scene', 'prefab', 'model'])

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function folderIcon(name: string, rel: string, open: boolean, unity: boolean): LucideIcon {
  const atRoot = !rel.includes('/')
  if (atRoot && (unity || name.startsWith('.'))) {
    const hit = ROOT_FOLDERS[name]
    if (hit) return hit === Package && open ? PackageOpen : hit
  }
  if (unity && rel.startsWith('Packages/') && rel.split('/').length === 2) return open ? PackageOpen : Package
  if (unity && NAMED_FOLDERS[name]) return NAMED_FOLDERS[name]
  return open ? FolderOpen : Folder
}

export function ExplorerIcon({
  name,
  rel,
  isDir,
  open,
  dim,
  unity
}: {
  name: string
  rel: string
  isDir: boolean
  open: boolean
  dim: boolean
  unity: boolean
}) {
  if (isDir) {
    const Icon = folderIcon(name, rel, open, unity)
    return <Icon aria-hidden data-explorer-icon={Icon.displayName ?? 'folder'} className={`h-3.5 w-3.5 shrink-0 ${dim ? 'text-sky-400/30' : 'text-sky-400/75'}`} strokeWidth={1.75} />
  }
  const kind = unityAssetKind(name)
  const Icon = (kind ? ASSET_ICONS[kind] : FILE_ICONS[extOf(name)]) ?? File
  const tone = dim ? 'text-zinc-600' : unity && kind && HIERARCHY_KINDS.has(kind) ? 'text-sky-300/85' : 'text-zinc-400'
  return <Icon aria-hidden data-explorer-icon={kind ?? (extOf(name) || 'file')} className={`h-3.5 w-3.5 shrink-0 ${tone}`} strokeWidth={1.75} />
}

const BINARY_KINDS: ReadonlySet<UnityAssetKind> = new Set(['model', 'texture', 'audio', 'video'])

export function isUnityYamlAsset(name: string): boolean {
  const kind = unityAssetKind(name)
  if (!kind || BINARY_KINDS.has(kind)) return false
  const ext = extOf(name)
  return ext !== 'ttf' && ext !== 'otf'
}
