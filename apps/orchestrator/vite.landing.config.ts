import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = resolve(__dirname, 'src/landing-demos')

export default defineConfig({
  root,
  base: '/demo/',
  publicDir: false,
  resolve: {
    alias: [
      { find: /^monaco-editor$/, replacement: resolve(root, 'monaco-lite.ts') },
      {
        find: /^monaco-editor\/esm\/vs\/language\/(json|css|html|typescript)\/\w+\.worker\?worker$/,
        replacement: 'monaco-editor/esm/vs/editor/editor.worker?worker'
      },
      { find: /^katex\/dist\/katex\.min\.css$/, replacement: resolve(root, 'empty.css') },
      { find: '@renderer', replacement: resolve(__dirname, 'src/renderer/src') },
      { find: '@shared', replacement: resolve(__dirname, 'src/shared') },
      { find: /^@satura\/report$/, replacement: resolve(root, 'report/kit.ts') }
    ],
    dedupe: ['react', 'react-dom']
  },
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' },
  build: {
    outDir: process.env.LANDING_DEMO_OUT || resolve(__dirname, '../landing/product/dist/demo'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 8000,
    rollupOptions: { input: { index: resolve(root, 'index.html'), report: resolve(root, 'report.html') } }
  }
})
