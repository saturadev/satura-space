import type * as Monaco from 'monaco-editor'
import type { IGrammar, IRawTheme, StateStack } from 'vscode-textmate'
import { TokenizationRegistry } from 'monaco-editor/esm/vs/editor/common/languages.js'
import darkPlusJson from './dark-plus.json'

type GrammarKey = 'ts' | 'tsx'

interface TmEngine {
  grammars: Record<GrammarKey, IGrammar>
  colors: string[]
  initial: StateStack
  loadMs: number
}

interface PatchedSupport {
  createBackgroundTokenizer?: (model: Monaco.editor.ITextModel, store: unknown) => undefined
}

const darkPlus = darkPlusJson as IRawTheme
const LANGUAGES = ['typescript', 'javascript'] as const
const MAX_LINE = 20000
const TIME_LIMIT_MS = 500
const FONT_STYLES = ['italic', 'bold', 'underline', 'strikethrough']
const TOKEN_TYPES = ['', '.comment', '.string', '.regexp']

const hex = (c: string): string => c.replace('#', '').toLowerCase()

function fontStyleName(bits: number): string {
  return FONT_STYLES.filter((_, i) => bits & (1 << i)).join(' ')
}

export function textMateThemeRules(): Monaco.editor.ITokenThemeRule[] {
  const colors = new Set<string>()
  for (const s of darkPlus.settings) if (s.settings.foreground) colors.add(hex(s.settings.foreground))
  const rules: Monaco.editor.ITokenThemeRule[] = []
  for (let fs = 1; fs < 16; fs++) rules.push({ token: `tmdef${fs}`, fontStyle: fontStyleName(fs) })
  for (const c of colors) {
    rules.push({ token: `tm${c}`, foreground: c })
    for (let fs = 1; fs < 16; fs++) rules.push({ token: `tm${c}f${fs}`, foreground: c, fontStyle: fontStyleName(fs) })
  }
  return rules
}

function tokenName(engine: TmEngine, metadata: number): string {
  const fg = (metadata & 0x00ff8000) >>> 15
  const fs = (metadata & 0x00007800) >>> 11
  const type = TOKEN_TYPES[(metadata & 0x00000300) >>> 8] ?? ''
  const color = fg > 1 ? engine.colors[fg] : undefined
  if (!color) return fs ? `tmdef${fs}${type}` : type.slice(1)
  return `tm${hex(color)}${fs ? `f${fs}` : ''}${type}`
}

class TmState implements Monaco.languages.IState {
  constructor(
    public grammar: IGrammar,
    public readonly stack: StateStack
  ) {}

  clone(): TmState {
    return new TmState(this.grammar, this.stack)
  }

  equals(other: Monaco.languages.IState): boolean {
    return other instanceof TmState && other.grammar === this.grammar && other.stack.equals(this.stack)
  }
}

export function grammarFor(languageId: string, path: string): GrammarKey {
  if (languageId === 'javascript') return 'tsx'
  return /\.tsx$/i.test(path) ? 'tsx' : 'ts'
}

let enginePromise: Promise<TmEngine> | null = null

function loadEngine(): Promise<TmEngine> {
  enginePromise ??= (async () => {
    const t0 = performance.now()
    const [tm, onig, wasm, tsSrc, tsxSrc] = await Promise.all([
      import('vscode-textmate'),
      import('vscode-oniguruma'),
      import('vscode-oniguruma/release/onig.wasm?url'),
      import('./TypeScript.tmLanguage.json?raw'),
      import('./TypeScriptReact.tmLanguage.json?raw')
    ])
    await onig.loadWASM(await (await fetch(wasm.default)).arrayBuffer())
    const sources: Record<string, [string, string]> = {
      'source.ts': [tsSrc.default, 'TypeScript.tmLanguage.json'],
      'source.tsx': [tsxSrc.default, 'TypeScriptReact.tmLanguage.json']
    }
    const registry = new tm.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (patterns) => new onig.OnigScanner(patterns),
        createOnigString: (s) => new onig.OnigString(s)
      }),
      loadGrammar: async (scope) => (sources[scope] ? tm.parseRawGrammar(...sources[scope]) : null),
      theme: darkPlus
    })
    const [ts, tsx] = await Promise.all([registry.loadGrammar('source.ts'), registry.loadGrammar('source.tsx')])
    if (!ts || !tsx) throw new Error('TextMate grammar missing')
    return { grammars: { ts, tsx }, colors: registry.getColorMap(), initial: tm.INITIAL, loadMs: Math.round(performance.now() - t0) }
  })()
  return enginePromise
}

let pending: TmState | null = null

function tokensProvider(engine: TmEngine, languageId: string): Monaco.languages.TokensProvider {
  return {
    getInitialState: () => {
      pending = new TmState(engine.grammars[grammarFor(languageId, '')], engine.initial)
      return pending
    },
    tokenize: (line, state) => {
      const s = state as TmState
      if (line.length > MAX_LINE) return { tokens: [{ startIndex: 0, scopes: '' }], endState: s }
      const r = s.grammar.tokenizeLine2(line, s.stack, TIME_LIMIT_MS)
      const tokens: Monaco.languages.IToken[] = []
      for (let i = 0; i < r.tokens.length; i += 2) tokens.push({ startIndex: r.tokens[i], scopes: tokenName(engine, r.tokens[i + 1]) })
      return { tokens, endState: r.stoppedEarly ? s : new TmState(s.grammar, r.ruleStack) }
    }
  }
}

function bindGrammar(engine: TmEngine, languageId: string): PatchedSupport['createBackgroundTokenizer'] {
  return (model) => {
    const state = pending
    pending = null
    if (state) state.grammar = engine.grammars[grammarFor(languageId, model.uri.path)]
    return undefined
  }
}

let installed = false

export function installTextMate(monaco: typeof Monaco): void {
  if (installed) return
  installed = true
  for (const languageId of LANGUAGES) {
    monaco.languages.registerTokensProviderFactory(languageId, {
      create: async () => {
        try {
          return tokensProvider(await loadEngine(), languageId)
        } catch (err) {
          console.warn(`[textmate] falling back to Monarch for ${languageId}: ${err instanceof Error ? err.message : String(err)}`)
          const mod = languageId === 'javascript' ? await import('monaco-editor/esm/vs/basic-languages/javascript/javascript.js') : await import('monaco-editor/esm/vs/basic-languages/typescript/typescript.js')
          return mod.language
        }
      }
    })
  }
  TokenizationRegistry.onDidChange((e) => {
    for (const languageId of LANGUAGES) {
      if (!e.changedLanguages.includes(languageId)) continue
      const support = TokenizationRegistry.get(languageId) as PatchedSupport | null
      if (!support || support.createBackgroundTokenizer || !enginePromise) continue
      void enginePromise.then((engine) => {
        if (TokenizationRegistry.get(languageId) !== support || support.createBackgroundTokenizer) return
        support.createBackgroundTokenizer = bindGrammar(engine, languageId)
        TokenizationRegistry.handleChange([languageId])
      }, () => undefined)
    }
  })
}

export async function textMateScopes(languageId: string, path: string, text: string): Promise<{ grammar: GrammarKey; lines: { start: number; end: number; scopes: string[] }[][] }> {
  const engine = await loadEngine()
  const key = grammarFor(languageId, path)
  const grammar = engine.grammars[key]
  let stack = engine.initial
  const lines = text.split('\n').map((line) => {
    const r = grammar.tokenizeLine(line, stack)
    stack = r.ruleStack
    return r.tokens.map((t) => ({ start: t.startIndex, end: t.endIndex, scopes: t.scopes }))
  })
  return { grammar: key, lines }
}

export async function textMateLoadMs(): Promise<number> {
  return (await loadEngine()).loadMs
}
