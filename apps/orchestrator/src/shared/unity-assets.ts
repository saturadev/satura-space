import type { TunerView } from './tuner'
import { isPlayableAudio, isPlayableVideo } from './media-url'

export type UnityAssetKind =
  | 'scene'
  | 'prefab'
  | 'model'
  | 'material'
  | 'texture'
  | 'audio'
  | 'video'
  | 'anim'
  | 'controller'
  | 'mask'
  | 'mixer'
  | 'font'
  | 'lighting'
  | 'terrain'
  | 'atlas'
  | 'timeline'
  | 'data'

export type UnityAssetLayout = 'hierarchy' | 'preview' | 'inspector'

const EXT_KIND: Record<string, UnityAssetKind> = {}

function add(kind: UnityAssetKind, exts: string): void {
  for (const e of exts.split(' ')) EXT_KIND[e] = kind
}

add('scene', 'unity')
add('prefab', 'prefab')
add('model', 'fbx obj blend dae 3ds max ma mb')
add('material', 'mat')
add('texture', 'png jpg jpeg tga psd tif tiff exr hdr bmp gif iff pict')
add('audio', 'wav mp3 ogg aif aiff flac mod it s3m xm')
add('video', 'mp4 mov webm avi m4v mpg mpeg ogv wmv')
add('anim', 'anim')
add('controller', 'controller overridecontroller')
add('mask', 'mask')
add('mixer', 'mixer')
add('font', 'ttf otf fontsettings')
add('lighting', 'lighting giparams')
add('terrain', 'terrainlayer brush')
add('atlas', 'spriteatlas spriteatlasv2')
add('timeline', 'playable signal')
add('data', 'asset preset physicmaterial physicsmaterial physicsmaterial2d rendertexture cubemap flare guiskin')

export const TUNER_ASSET_VIEW_PREFIX = '@asset:'

const MAX_ASSET_PATH = 512

function ext(path: string): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  return dot > slash + 1 ? path.slice(dot + 1).toLowerCase() : ''
}

export function unityAssetKind(path: string): UnityAssetKind | null {
  return EXT_KIND[ext(path)] ?? null
}

const PLAIN_TEXT_EXTS = new Set(
  'md markdown txt text log csv tsv rtf cs js ts py lua json jsonc xml yaml yml html htm css uss uxml tss shader shadergraph hlsl cginc glsl compute raytrace ini cfg toml rsp sh bat ps1 gitignore editorconfig'.split(' ')
)

const BROWSER_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'])

export function opensInSatura(path: string): boolean {
  const e = ext(path)
  return PLAIN_TEXT_EXTS.has(e) || BROWSER_IMAGE_EXTS.has(e) || isPlayableVideo(path) || isPlayableAudio(path)
}

export function unityAssetViewKind(path: string): UnityAssetKind {
  return unityAssetKind(path) ?? 'data'
}

export function isUnityAssetPath(rel: string): boolean {
  if (!rel || rel.length > MAX_ASSET_PATH || rel.includes('\\') || rel.includes('\0')) return false
  if (!/^(Assets|Packages)\/./.test(rel)) return false
  if (/\.meta$/i.test(rel)) return false
  return !rel.split('/').some((p) => p === '..' || p === '.' || p === '')
}

export function unityAssetRelPath(projectPath: string, file: string): string | null {
  const root = projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const f = file.replace(/\\/g, '/')
  if (!root || !f.startsWith(root + '/')) return null
  const rel = f.slice(root.length + 1)
  return isUnityAssetPath(rel) ? rel : null
}

export function unityAssetLayout(kind: UnityAssetKind): UnityAssetLayout {
  if (kind === 'scene' || kind === 'prefab' || kind === 'model') return 'hierarchy'
  if (kind === 'material' || kind === 'texture') return 'preview'
  return 'inspector'
}

export function assetTunerViewName(rel: string): string {
  return `${TUNER_ASSET_VIEW_PREFIX}${rel}`
}

export function assetTunerViewPath(name: string): string | null {
  if (!name.startsWith(TUNER_ASSET_VIEW_PREFIX)) return null
  const rel = name.slice(TUNER_ASSET_VIEW_PREFIX.length)
  return isUnityAssetPath(rel) ? rel : null
}

export function assetFileName(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1)
}

export function assetTunerView(name: string): TunerView | null {
  const rel = assetTunerViewPath(name)
  const kind = rel ? unityAssetViewKind(rel) : null
  if (!rel || !kind) return null
  const base: TunerView = {
    name,
    title: assetFileName(rel),
    note: '',
    paneKey: '',
    kind: 'objects',
    objects: [],
    assets: [],
    buttons: [],
    updatedAt: 0
  }
  if (kind === 'scene') return { ...base, kind: 'scene', scene: rel }
  if (kind === 'prefab' || kind === 'model') return { ...base, kind: 'prefabs', prefabs: [rel] }
  if (unityAssetLayout(kind) === 'preview') return { ...base, kind: 'prefabs', prefabs: [rel], assets: [{ path: rel }] }
  return { ...base, assets: [{ path: rel }] }
}
