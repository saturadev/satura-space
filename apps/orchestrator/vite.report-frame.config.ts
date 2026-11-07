import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const renderer = resolve(__dirname, 'src/renderer/src')
const report = resolve(renderer, 'components/report')
const frame = resolve(renderer, 'report-frame')

const SWAPS: Record<string, string> = {
  [resolve(report, 'code-text')]: resolve(renderer, 'report-export/static-code-text.tsx'),
  [resolve(renderer, 'lib/editor/monaco-kit')]: resolve(frame, 'monaco-kit-frame.ts')
}

function frameSwaps(): Plugin {
  return {
    name: 'satura-report-frame-swaps',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null
      return SWAPS[resolve(dirname(importer), source).replace(/\.tsx?$/, '')] ?? null
    }
  }
}

function inlineWorkers(): Plugin {
  return {
    name: 'satura-report-frame-inline-workers',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!source.endsWith('?worker')) return null
      return this.resolve(`${source}&inline`, importer, { skipSelf: true })
    }
  }
}

const BASIC_LANGUAGES = 'satura:monaco-basic-languages'

function basicLanguages(): Plugin {
  return {
    name: 'satura-report-frame-basic-languages',
    resolveId(source) {
      return source === BASIC_LANGUAGES ? `\0${BASIC_LANGUAGES}` : null
    },
    load(id) {
      if (id !== `\0${BASIC_LANGUAGES}`) return null
      const main = readFileSync(resolve(__dirname, 'node_modules/monaco-editor/esm/vs/editor/editor.main.js'), 'utf8')
      return main
        .split('\n')
        .filter((l) => l.startsWith("import '../basic-languages/"))
        .map((l) => l.replace("'../basic-languages/", "'monaco-editor/esm/vs/basic-languages/"))
        .join('\n')
    }
  }
}

function cssIntoJs(): Plugin {
  return {
    name: 'satura-report-frame-css-into-js',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const css = Object.values(bundle)
        .filter((f) => f.type === 'asset' && f.fileName.endsWith('.css'))
        .map((f) => {
          delete bundle[f.fileName]
          return f.type === 'asset' ? String(f.source) : ''
        })
        .join('\n')
      if (!css) return
      for (const f of Object.values(bundle)) {
        if (f.type !== 'chunk' || !f.isEntry) continue
        f.code = `(function(){var s=document.createElement('style');s.setAttribute('data-satura-chunk','');s.textContent=${JSON.stringify(css)};document.head.appendChild(s)})();\n${f.code}`
      }
    }
  }
}

export default defineConfig(({ mode }) => {
  const monaco = mode === 'monaco'
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
    plugins: [frameSwaps(), inlineWorkers(), react(), tailwindcss(), ...(monaco ? [basicLanguages(), cssIntoJs()] : [])],
    worker: { format: 'iife' },
    build: {
      outDir: process.env.SATURA_REPORT_FRAME_OUT || resolve(__dirname, 'out/report-frame'),
      emptyOutDir: !monaco,
      target: 'es2022',
      minify: 'esbuild',
      cssCodeSplit: false,
      modulePreload: false,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 40000,
      assetsInlineLimit: () => true,
      lib: {
        entry: resolve(frame, monaco ? 'monaco-chunk.ts' : 'main.tsx'),
        formats: ['iife'],
        name: monaco ? 'SaturaReportMonaco' : 'SaturaReportFrame',
        fileName: () => (monaco ? 'monaco.js' : 'runtime.js'),
        cssFileName: monaco ? 'monaco' : 'runtime'
      },
      rollupOptions: { output: { inlineDynamicImports: true } }
    }
  }
})
