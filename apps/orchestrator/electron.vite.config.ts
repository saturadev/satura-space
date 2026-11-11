import { resolve } from 'node:path'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { build as viteBuild, searchForWorkspaceRoot, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { iifePlugin } from './vite-iife-plugin'

const shared = resolve(__dirname, 'src/shared')
const plugins = resolve(__dirname, '../../plugins')
const reactTypes = realpathSync(resolve(__dirname, 'node_modules/@types/react'))
const tsLib = resolve(realpathSync(resolve(__dirname, 'node_modules/typescript')), 'lib')
const reportTypes = { '@react-types': reactTypes, '@csstype': resolve(reactTypes, '../../csstype'), '@ts-lib': tsLib }
const version = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version

const buildOnly = process.env.SATURA_BUILD_ONLY?.split(',').map((t) => t.trim()).filter(Boolean)
const builds = (target: string): boolean => !buildOnly || buildOnly.includes(target)
function reportExportRuntime(): Plugin {
  return {
    name: 'satura-report-export-runtime',
    apply: 'build',
    async closeBundle() {
      await viteBuild({ configFile: resolve(__dirname, 'vite.report-export.config.ts') })
      await viteBuild({ configFile: resolve(__dirname, 'vite.report-export.config.ts'), mode: 'lite' })
      await viteBuild({ configFile: resolve(__dirname, 'vite.report-frame.config.ts') })
      await viteBuild({ configFile: resolve(__dirname, 'vite.report-frame.config.ts'), mode: 'monaco' })
    }
  }
}

function newestMtime(dir: string): number {
  let newest = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name)
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs)
  }
  return newest
}

function devRemoteWeb(): Plugin {
  return {
    name: 'satura-dev-remote-web',
    apply: () => process.env.NODE_ENV_ELECTRON_VITE === 'development',
    closeBundle() {
      if (process.env.SATURA_REMOTE_WEB) return
      const index = resolve(__dirname, 'out/remote/app/index.html')
      const built = existsSync(index) ? statSync(index).mtimeMs : 0
      const sources = Math.max(newestMtime(resolve(__dirname, 'src/renderer')), newestMtime(shared), newestMtime(resolve(__dirname, '../../packages/companion-app/phone-site/m')))
      if (built > sources) return
      console.log('[remote] phone bundle is stale, rebuilding it in the background')
      void viteBuild({ configFile: resolve(__dirname, 'vite.remote.config.ts'), logLevel: 'error' }).then(
        () => console.log('[remote] phone bundle rebuilt'),
        (e: unknown) => console.log(`[remote] phone bundle build failed: ${(e as Error).message}`)
      )
    }
  }
}

export default defineConfig({
  main: builds('main') ? {
    plugins: [externalizeDepsPlugin(), iifePlugin(__dirname), devRemoteWeb()],
    resolve: { alias: { '@shared': shared, '@satura/plugin': resolve(__dirname, 'src/main/plugins/api.ts'), ...reportTypes } },
    build: {
      rollupOptions: {
        onwarn(warning, warn) {
          if (/dynamically imported by \S*[\\/]src[\\/]main[\\/]handles[\\/]fn\.ts but also/.test(warning.message)) return
          warn(warning)
        },
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'unity-log-worker': resolve(__dirname, 'src/main/unity/unity-log-worker.ts'),
          'daemon-entry': resolve(__dirname, 'src/main/daemon/daemon-entry.ts'),
          'satura-exec-worker': resolve(__dirname, 'src/main/satura-exec/worker.ts'),
          'report-compile-worker': resolve(__dirname, 'src/main/report/compile-worker.ts')
        }
      }
    }
  } : undefined,
  preload: builds('preload') ? {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'video-recorder': resolve(__dirname, 'src/preload/video-recorder.ts'),
          'phone-video-convert': resolve(__dirname, 'src/preload/phone-video-convert.ts'),
          'remote-video': resolve(__dirname, 'src/main/remote-video/encoder-preload.ts')
        }
      }
    }
  } : undefined,
  renderer: builds('renderer') ? {
    server: { port: Number(process.env.SATURA_DEV_RENDERER_PORT) || 5273, strictPort: true, hmr: false, ws: false, watch: null, fs: { allow: [searchForWorkspaceRoot(__dirname), plugins] } },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': shared,
        '@satura/plugin': resolve(__dirname, 'src/renderer/src/plugins/api.tsx')
      },
      dedupe: ['react', 'react-dom', 'lucide-react']
    },
    optimizeDeps: { entries: ['index.html', 'src/**/*.{ts,tsx}', '!src/**/*.d.ts', '!src/report-frame/**'] },
    build: { minify: 'esbuild' },
    plugins: [react(), tailwindcss(), reportExportRuntime()]
  } : undefined
})
