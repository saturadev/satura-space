import { cpSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build as viteBuild, defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { bundleIife } from './vite-iife-plugin'
import { REMOTE_APP_MANIFEST, REMOTE_PROTOCOL } from './src/shared/remote-version'
import { REPORT_FRAME_BOOT_FILE, REPORT_FRAME_INLINE_CSP, frameBootHtml } from './src/shared/report-frame'
import pkg from './package.json'

const siteOut = process.env.SATURA_REMOTE_OUT || resolve(__dirname, 'out/remote')
const appOut = resolve(siteOut, 'app')
const entrySource = resolve(__dirname, '../../packages/companion-app/phone-site/m')

const SITE_RULES = ['/ /m/ 302', '/m /m/ 301', '/h/all /h/all/ 301', '/h/all/ /app/home 200', '/h/:id /h/:id/ 301', `/h/:id/report-frame/${REPORT_FRAME_BOOT_FILE} /app/report-frame/${REPORT_FRAME_BOOT_FILE.replace(/\.html$/, '')} 200`, '/h/:id/* /app/:splat 200']

const PHONE_RELAY = process.env.SATURA_PHONE_RELAY
const PHONE_ACCOUNT = process.env.SATURA_PHONE_ACCOUNT

function phoneConfig(): { relay: string; account: string | null } | null {
  if (!PHONE_RELAY) return null
  const relay = new URL(PHONE_RELAY)
  if (!/^wss?:$/.test(relay.protocol) || relay.search || relay.hash) throw new Error(`SATURA_PHONE_RELAY must be a ws: or wss: address, not ${PHONE_RELAY}`)
  const account = PHONE_ACCOUNT ? new URL(PHONE_ACCOUNT) : null
  if (account && (!/^https?:$/.test(account.protocol) || account.href !== `${account.origin}/`)) throw new Error(`SATURA_PHONE_ACCOUNT must be an origin, not ${PHONE_ACCOUNT}`)
  return { relay: relay.href, account: account ? account.origin : null }
}

function siteHeaders(config: { relay: string; account: string | null }): string {
  const relay = new URL(config.relay)
  const relayHttp = `${relay.protocol === 'wss:' ? 'https:' : 'http:'}//${relay.host}`
  const connect = ["'self'", ...(config.account ? [config.account] : []), relayHttp, relay.origin]
  const app = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self'",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'"
  ].join('; ')
  const frame = `${REPORT_FRAME_INLINE_CSP}; frame-ancestors 'self'`
  const rule = (path: string, lines: string[]): string => `${path}\n${lines.map((l) => `  ${l}`).join('\n')}\n`
  const immutable = ['! Cache-Control', 'Cache-Control: public, max-age=31536000, immutable']
  const framed = ['! Content-Security-Policy', `Content-Security-Policy: ${frame}`]
  return [
    rule('/*', [
      `Content-Security-Policy: ${app}`,
      'X-Frame-Options: SAMEORIGIN',
      'X-Content-Type-Options: nosniff',
      'Cross-Origin-Opener-Policy: same-origin',
      'Referrer-Policy: same-origin',
      'Permissions-Policy: camera=(self), microphone=(), geolocation=()',
      'Cache-Control: no-cache'
    ]),
    rule('/h/:id/assets/*', immutable),
    rule('/app/assets/*', immutable),
    rule('/h/:id/report-frame/*', framed),
    rule('/app/report-frame/*', framed)
  ].join('')
}

const NOT_FOUND = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Satura Remote</title><style>html,body{margin:0;min-height:100%;background:#000;color:#e5e7eb;font:15px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:14px;text-align:center}a{color:#0a84ff;font-weight:600;text-decoration:none}</style></head><body><h1>Nothing here</h1><a href="/m/">Open Satura Remote</a></body></html>'

function mediaWorker(): Plugin {
  return {
    name: 'satura-media-sw',
    apply: 'build',
    async generateBundle() {
      const { code } = await bundleIife(__dirname, resolve(__dirname, 'src/renderer/src/remote/media-sw.ts'), 'inline')
      this.emitFile({ type: 'asset', fileName: 'media-sw.js', source: code })
    }
  }
}

function reportFrame(): Plugin {
  return {
    name: 'satura-remote-report-frame',
    apply: 'build',
    async closeBundle() {
      const prev = process.env.SATURA_REPORT_FRAME_OUT
      process.env.SATURA_REPORT_FRAME_OUT = resolve(appOut, 'report-frame')
      try {
        await viteBuild({ configFile: resolve(__dirname, 'vite.report-frame.config.ts'), logLevel: 'error' })
        await viteBuild({ configFile: resolve(__dirname, 'vite.report-frame.config.ts'), mode: 'monaco', logLevel: 'error' })
        writeFileSync(resolve(appOut, 'report-frame', REPORT_FRAME_BOOT_FILE), frameBootHtml())
      } finally {
        if (prev === undefined) delete process.env.SATURA_REPORT_FRAME_OUT
        else process.env.SATURA_REPORT_FRAME_OUT = prev
      }
    }
  }
}

function phoneSite(): Plugin {
  const own = ['m', '_redirects', '_headers', '404.html', 'phone-config.json', REMOTE_APP_MANIFEST]
  const config = phoneConfig()
  return {
    name: 'satura-remote-site',
    apply: 'build',
    buildStart() {
      for (const name of own) rmSync(resolve(siteOut, name), { recursive: true, force: true })
    },
    closeBundle() {
      cpSync(entrySource, resolve(siteOut, 'm'), { recursive: true })
      writeFileSync(resolve(siteOut, '_redirects'), `${SITE_RULES.join('\n')}\n`)
      writeFileSync(resolve(siteOut, '404.html'), NOT_FOUND)
      writeFileSync(resolve(siteOut, REMOTE_APP_MANIFEST), JSON.stringify({ protocol: REMOTE_PROTOCOL, minHost: REMOTE_PROTOCOL, version: pkg.version }))
      if (!config) return
      writeFileSync(resolve(siteOut, 'phone-config.json'), `${JSON.stringify(config)}\n`)
      writeFileSync(resolve(siteOut, '_headers'), siteHeaders(config))
    }
  }
}

export default defineConfig({
  root: resolve(__dirname, 'src/renderer/src/remote'),
  base: './',
  publicDir: false,
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    },
    dedupe: ['react', 'react-dom']
  },
  plugins: [react(), tailwindcss(), mediaWorker(), phoneSite(), reportFrame()],
  build: {
    outDir: appOut,
    emptyOutDir: true,
    target: 'es2022',
    minify: 'esbuild',
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/renderer/src/remote/index.html'),
        home: resolve(__dirname, 'src/renderer/src/remote/home.html')
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js'
      }
    }
  }
})
