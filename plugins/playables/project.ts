import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const DIR = 'Playable'
export const CONFIG = `${DIR}/playable.json`
export const REFERENCE = '.sspace/playables/runtime'

export class PlayableError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
  }
}

export interface PlayableConfig {
  name: string
  title?: string
  scenes: string[]
  startScene: string
  extraSprites?: string[]
  extraAssets?: string[]
  atlasMaxSize?: number
  atlasPadding?: number
  spriteScale?: number
  spriteScales?: { path: string; scale: number }[]
  skipComponents?: string[]
  entry?: string
  webpQuality?: number
  textures?: Record<string, unknown>
  audio?: Record<string, unknown>
  meshes?: Record<string, unknown>
  fontFiles?: Record<string, string>
  budget?: number
  networks?: string[]
  storeUrl?: { ios?: string; android?: string }
  stage?: Record<string, unknown>
  overrides?: unknown[]
  clipOverrides?: unknown[]
  cta?: { label?: string; url?: string; bottom?: number }
  hint?: Record<string, unknown>
  endCard?: Record<string, unknown>
  seed?: number
  [key: string]: unknown
}

export interface Layout {
  root: string
  dir: string
  configPath: string
  build: string
  out: string
  runs: string
  config: PlayableConfig
}

export function inside(root: string, rel: string): string {
  const full = resolve(root, rel)
  const r = relative(root, full)
  if (!r || r.startsWith('..') || isAbsolute(r)) throw new PlayableError(`${rel} is outside the project.`, 'path')
  return full
}

export function rel(root: string, full: string): string {
  return relative(root, full).split(sep).join('/')
}

export async function layout(root: string): Promise<Layout> {
  if (!root) throw new PlayableError('There is no project open.', 'no-project')
  const configPath = join(root, CONFIG)
  const text = await readFile(configPath, 'utf8').catch(() => null)
  if (text === null) throw new PlayableError(`${CONFIG} is missing. Run playables.init() first.`, 'no-config')
  let config: PlayableConfig
  try {
    config = JSON.parse(text)
  } catch (e) {
    throw new PlayableError(`${CONFIG} is not valid JSON: ${(e as Error).message}`, 'config')
  }
  if (!config.name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(config.name)) throw new PlayableError(`${CONFIG}: name is lowercase letters, digits and dashes.`, 'config')
  if (!Array.isArray(config.scenes) || !config.scenes.length) throw new PlayableError(`${CONFIG}: scenes lists no scene.`, 'config')
  if (!config.startScene) throw new PlayableError(`${CONFIG}: startScene is missing.`, 'config')
  const dir = join(root, DIR)
  return { root, dir, configPath, build: join(dir, 'build'), out: join(dir, 'out'), runs: join(dir, 'verify', 'runs'), config }
}

const GITIGNORE = 'build/\nout/\nverify/runs/\n'

const MAIN = `import { Playable, registerTypes } from 'playables';
import { GameTypes } from './index.js';

registerTypes(GameTypes);
Playable.boot(window.__PLAYABLE__).catch((error) => {
  Playable.errors.push(String(error));
  console.error(error);
});
`

const INDEX = `export const GameTypes = {
};
`

export async function initProject(root: string, options: { name?: string; scene?: string; title?: string }): Promise<{ created: string[]; kept: string[] }> {
  if (!root) throw new PlayableError('There is no project open.', 'no-project')
  const created: string[] = []
  const kept: string[] = []
  const scene = options.scene || 'Assets/Scenes/Main.unity'
  const sceneName = scene.split('/').pop()!.replace(/\.unity$/, '')
  const name = (options.name || sceneName).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'playable'
  const config: PlayableConfig = {
    name,
    title: options.title || sceneName,
    scenes: [scene],
    startScene: sceneName,
    extraSprites: [],
    atlasMaxSize: 2048,
    atlasPadding: 2,
    spriteScale: 1,
    webpQuality: 85,
    budget: 5_000_000,
    entry: 'game/main.js',
    stage: { width: 9, height: 16, maxPixelHeight: 1920, background: '#000000' },
    overrides: [],
    cta: { label: 'Install now', url: 'https://example.com/', bottom: 5 },
    hint: { text: '', bottom: 15 },
    endCard: { winTitle: 'You win!', loseTitle: 'Try again', subtitle: '', playAgain: 'Play again', delayWin: 2, delayLose: 1.5, afterMoves: 0, afterSeconds: 0 },
    networks: ['applovin', 'unity', 'ironsource', 'mintegral', 'google', 'meta', 'tiktok'],
    storeUrl: { ios: '', android: '' }
  }
  const files: Record<string, string> = {
    [CONFIG]: JSON.stringify(config, null, 2) + '\n',
    [`${DIR}/.gitignore`]: GITIGNORE,
    [`${DIR}/game/main.js`]: MAIN,
    [`${DIR}/game/index.js`]: INDEX,
    [`${DIR}/game/MAPPING.md`]: '# C# to JS mapping\n\n| C# file | JS file | Anything beyond the standard rules |\n|---|---|---|\n',
    [`${DIR}/verify/smoke.json`]: JSON.stringify({ runs: [{ scene: sceneName, scenePath: scene, seed: 1, steps: [{ kind: 'wait', frames: 120 }] }], probes: [], finalWait: 60 }, null, 2) + '\n'
  }
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path)
    if (existsSync(full)) {
      kept.push(path)
      continue
    }
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, text)
    created.push(path)
  }
  return { created, kept }
}
