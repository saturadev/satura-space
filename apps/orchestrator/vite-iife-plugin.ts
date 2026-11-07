import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Plugin } from 'vite'

const SUFFIX = '?iife'

type Esbuild = {
  build: (options: Record<string, unknown>) => Promise<{
    outputFiles: { text: string }[]
    metafile: { inputs: Record<string, unknown> }
  }>
}

function loadEsbuild(appDir: string): Esbuild {
  const fromApp = createRequire(join(appDir, 'package.json'))
  return createRequire(fromApp.resolve('vite'))('esbuild') as Esbuild
}

export async function bundleIife(
  appDir: string,
  entry: string,
  legalComments: 'none' | 'inline' = 'none'
): Promise<{ code: string; inputs: string[] }> {
  const result = await loadEsbuild(appDir).build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'neutral',
    target: 'es2022',
    legalComments,
    minifySyntax: true,
    metafile: true,
    absWorkingDir: appDir,
    logLevel: 'silent'
  })
  const inputs = Object.keys(result.metafile.inputs).map((p) => join(appDir, p))
  return { code: result.outputFiles[0].text, inputs }
}

export function iifePlugin(appDir: string): Plugin {
  return {
    name: 'satura-iife',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!source.endsWith(SUFFIX)) return null
      const resolved = await this.resolve(source.slice(0, -SUFFIX.length), importer, { skipSelf: true })
      return resolved ? `${resolved.id}${SUFFIX}` : null
    },
    async load(id) {
      if (!id.endsWith(SUFFIX)) return null
      const entry = id.slice(0, -SUFFIX.length)
      const { code, inputs } = await bundleIife(appDir, entry)
      for (const file of inputs) this.addWatchFile(file)
      return `export default ${JSON.stringify(code)}`
    }
  }
}
