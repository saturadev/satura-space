import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const renderer = resolve(__dirname, 'src/renderer/src')
const report = resolve(renderer, 'components/report')
const offline = resolve(renderer, 'report-export')

const SWAPS: Record<string, string> = {
  [resolve(report, 'git-file-diff')]: resolve(offline, 'static-file-diff.tsx'),
  [resolve(report, 'code-text')]: resolve(offline, 'static-code-text.tsx')
}

const LITE_SWAPS: Record<string, string> = {
  ...SWAPS,
  [resolve(renderer, 'components/workbench/MarkdownView')]: resolve(offline, 'plain-markdown.tsx')
}

function offlineSwaps(swaps: Record<string, string>): Plugin {
  return {
    name: 'satura-report-offline',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null
      return swaps[resolve(dirname(importer), source).replace(/\.tsx?$/, '')] ?? null
    },
    writeBundle(options, bundle) {
      for (const name of Object.keys(bundle)) {
        if (!name.endsWith('.css') || !options.dir) continue
        const file = join(options.dir, name)
        writeFileSync(file, readFileSync(file, 'utf8').replace(/@font-face\{[^}]*font-family:\s*["']?KaTeX_[^}]*\}/g, ''))
      }
    }
  }
}

export default defineConfig(({ mode }) => {
  const lite = mode === 'lite'
  return {
    root: renderer,
    publicDir: false,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': '"production"' },
    resolve: {
      alias: {
        '@renderer': renderer,
        '@shared': resolve(__dirname, 'src/shared')
      },
      dedupe: ['react', 'react-dom']
    },
    plugins: [offlineSwaps(lite ? LITE_SWAPS : SWAPS), react(), tailwindcss()],
    build: {
      outDir: process.env.SATURA_REPORT_EXPORT_OUT || resolve(__dirname, 'out/report-export'),
      emptyOutDir: !lite,
      target: 'es2022',
      minify: 'esbuild',
      cssCodeSplit: false,
      modulePreload: false,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 20000,
      lib: {
        entry: resolve(offline, 'standalone.tsx'),
        formats: ['iife'],
        name: 'SaturaReport',
        fileName: () => (lite ? 'runtime-lite.js' : 'runtime.js'),
        cssFileName: lite ? 'runtime-lite' : 'runtime'
      },
      rollupOptions: { output: { inlineDynamicImports: true } }
    }
  }
})
