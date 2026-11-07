import { dirname, posix } from 'node:path'
import ts from 'typescript'
import type * as TS from 'typescript'
import type { ReportCompileResult, ReportDiagnostic } from '@shared/report-compile'
import { dashboardKindOf } from '@shared/dashboard'
import { displayPath, formatDiagnostics, hashOf } from './compile-util'

type Ts = typeof TS

type Kind = 'report' | 'widget' | 'alert'

const ALLOWED_IMPORTS: Record<Kind, Set<string>> = {
  report: new Set(['react', '@satura/report']),
  widget: new Set(['react', '@satura/report', '@satura/dashboard']),
  alert: new Set(['@satura/dashboard/alert'])
}

const WORDS: Record<Kind, { some: string; one: string; imports: string; defaultHint: string }> = {
  report: {
    some: 'Reports',
    one: 'a report',
    imports: "'react' and '@satura/report'",
    defaultHint: 'A report needs a default export: export default function MyReport() { return <Report title="…">…</Report> }'
  },
  widget: {
    some: 'Widgets',
    one: 'a widget',
    imports: "'react', '@satura/report' and '@satura/dashboard'",
    defaultHint: "A widget needs a default export: export default function Widget() { return <Stat label=\"…\" value={…} /> }"
  },
  alert: {
    some: 'Alerts',
    one: 'an alert',
    imports: "'@satura/dashboard/alert'",
    defaultHint: "An alert needs a default export: export default alert({ every: 60, fetch: {...}, when: (data) => ... })"
  }
}

const BLOCKED_GLOBALS = new Set([
  'window',
  'globalThis',
  'self',
  'top',
  'parent',
  'frames',
  'opener',
  'document',
  'location',
  'navigator',
  'require',
  'process',
  'eval',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'importScripts',
  'postMessage',
  'Function',
  'Reflect'
])

const REFLECTIVE = new Set(['constructor', '__proto__', 'prototype', 'caller', 'callee', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'])

const DOM_ESCAPES = new Set(['ownerDocument', 'defaultView', 'view', 'getRootNode', 'contentWindow', 'contentDocument', 'frameElement'])

const BLOCKED_TAGS = new Set(['style', 'link', 'script', 'iframe', 'meta', 'base', 'object', 'embed', 'frame', 'frameset'])

let typesLoad: Promise<typeof import('./report-types')> | null = null

function loadTypes(): Promise<typeof import('./report-types')> {
  typesLoad ??= import('./report-types')
  return typesLoad
}

const sharedFiles = new Map<string, TS.SourceFile>()
let lastProgram: TS.Program | undefined

function compilerOptions(ts: Ts): TS.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    isolatedModules: true,
    allowJs: false
  }
}

function makeHost(
  ts: Ts,
  file: string,
  source: string,
  types: typeof import('./report-types')
): TS.CompilerHost {
  const libDir = types.LIB_ROOT
  const readShared = (name: string): string | undefined => types.TYPE_FILES[name]
  const resolveOne = (name: string, containing: string): TS.ResolvedModuleFull | undefined => {
    let target: string | undefined = types.MODULES[name]
    if (!target && name.startsWith('.') && containing.startsWith(types.TYPES_ROOT)) {
      const base = posix.resolve(posix.dirname(containing), name)
      target = [`${base}.d.ts`, `${base}/index.d.ts`, base].find((p) => p in types.TYPE_FILES)
    }
    if (!target) return undefined
    return { resolvedFileName: target, extension: ts.Extension.Dts, isExternalLibraryImport: true }
  }
  return {
    getSourceFile: (name, lang) => {
      if (name === file) return ts.createSourceFile(name, source, lang, true, /\.tsx$/i.test(name) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      const cached = sharedFiles.get(name)
      if (cached) return cached
      const text = readShared(name)
      if (text === undefined) return undefined
      const sf = ts.createSourceFile(name, text, lang, false)
      sharedFiles.set(name, sf)
      return sf
    },
    fileExists: (name) => name === file || name in types.TYPE_FILES,
    readFile: (name) => (name === file ? source : readShared(name)),
    resolveModuleNameLiterals: (literals, containing) =>
      literals.map((lit) => ({ resolvedModule: resolveOne(lit.text, containing) })),
    getDefaultLibFileName: (o) => `${libDir}/${ts.getDefaultLibFileName(o)}`,
    getDefaultLibLocation: () => libDir,
    writeFile: () => {},
    getCurrentDirectory: () => dirname(file),
    getDirectories: () => [],
    directoryExists: () => true,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    realpath: (p) => p
  }
}

function isPropertyName(ts: Ts, node: TS.Identifier): boolean {
  const p = node.parent
  if (!p) return false
  if (ts.isPropertyAccessExpression(p) && p.name === node) return true
  if (ts.isQualifiedName(p) && p.right === node) return true
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === node) return true
  if (ts.isBindingElement(p) && p.propertyName === node) return true
  if (ts.isJsxAttribute(p)) return true
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return true
  if (ts.isEnumMember(p) && p.name === node) return true
  return false
}

function lint(ts: Ts, program: TS.Program, sf: TS.SourceFile, kind: Kind, push: (node: TS.Node, message: string) => void): void {
  const words = WORDS[kind]
  const allowed = ALLOWED_IMPORTS[kind]
  const checker = program.getTypeChecker()
  const fromLib = (sym: TS.Symbol | undefined): boolean => {
    const decls = sym?.declarations
    return !!decls && decls.length > 0 && decls.every((d) => program.isSourceFileDefaultLibrary(d.getSourceFile()))
  }
  const fromTypes = (sym: TS.Symbol | undefined): boolean =>
    !!sym?.declarations?.length && sym.declarations.every((d) => program.isSourceFileDefaultLibrary(d.getSourceFile()) || d.getSourceFile().fileName.includes('/react/'))
  const literalKey = (e: TS.Expression): string | null => (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : null)
  const visit = (node: TS.Node): void => {
    if (ts.isPropertyAccessExpression(node) && REFLECTIVE.has(node.name.text)) {
      push(node.name, `${words.some} can't reach '${node.name.text}'.`)
    } else if (ts.isElementAccessExpression(node) && REFLECTIVE.has(literalKey(node.argumentExpression) ?? '')) {
      push(node.argumentExpression, `${words.some} can't reach '${literalKey(node.argumentExpression)}'.`)
    } else if (ts.isPropertyAccessExpression(node) && DOM_ESCAPES.has(node.name.text)) {
      const sym = checker.getSymbolAtLocation(node.name)
      const loose = !sym && (checker.getTypeAtLocation(node.expression).flags & ts.TypeFlags.Any) !== 0
      if (loose || fromTypes(sym)) push(node.name, `${words.some} can't reach the page through '${node.name.text}'.`)
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!allowed.has(node.moduleSpecifier.text)) {
        push(node.moduleSpecifier, `${words.some} can import only from ${words.imports}, not '${node.moduleSpecifier.text}'.`)
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      push(node, `${words.some} can't load modules at runtime. Import from ${words.imports} at the top.`)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      push(node.moduleSpecifier, `${words.some} can't re-export other modules.`)
    } else if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)) {
      const tag = node.tagName.text
      if (BLOCKED_TAGS.has(tag)) push(node.tagName, `<${tag}> isn't allowed in ${words.one}. Style elements with the style prop instead.`)
    } else if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'dangerouslySetInnerHTML') {
      push(node.name, `dangerouslySetInnerHTML isn't allowed in ${words.one}. Use <Markdown> for formatted text.`)
    } else if (ts.isIdentifier(node) && BLOCKED_GLOBALS.has(node.text) && !isPropertyName(ts, node)) {
      const sym = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node)
      if (fromLib(sym)) push(node, `${words.some} can't use '${node.text}'. ${kind === 'widget' ? "Use useFetch from '@satura/dashboard' for network data." : `Only ${words.imports} are available.`}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  const moduleSym = checker.getSymbolAtLocation(sf)
  const hasDefault = !!moduleSym && checker.getExportsOfModule(moduleSym).some((s) => s.escapedName === 'default')
  if (!hasDefault) push(sf, words.defaultHint)
}

function toDiagnostic(ts: Ts, d: TS.Diagnostic, shown: string): ReportDiagnostic {
  const message = ts.flattenDiagnosticMessageText(d.messageText, '\n')
  if (d.file && d.start !== undefined) {
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start)
    return { file: shown, line: line + 1, column: character + 1, code: d.code ? `TS${d.code}` : '', message }
  }
  return { file: shown, line: 0, column: 0, code: d.code ? `TS${d.code}` : '', message }
}

export async function compileSource(file: string, source: string, root: string | undefined): Promise<ReportCompileResult> {
  const t0 = performance.now()
  const kind: Kind = dashboardKindOf(file) ?? 'report'
  const types = await loadTypes()
  const options = compilerOptions(ts)
  const shown = displayPath(file, root)
  const tsFile = file.replace(/\\/g, '/')
  const host = makeHost(ts, tsFile, source, types)
  const program = ts.createProgram({ rootNames: [tsFile], options, host, oldProgram: lastProgram })
  lastProgram = program
  const sf = program.getSourceFile(tsFile)
  const diagnostics: ReportDiagnostic[] = []
  if (sf) {
    const own = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]
    for (const d of own) diagnostics.push(toDiagnostic(ts, d, shown))
    for (const d of program.getGlobalDiagnostics()) diagnostics.push(toDiagnostic(ts, d, shown))
    const lintFound: ReportDiagnostic[] = []
    lint(ts, program, sf, kind, (node, message) => {
      const start = node.kind === ts.SyntaxKind.SourceFile ? 0 : node.getStart(sf)
      const { line, character } = sf.getLineAndCharacterOfPosition(start)
      lintFound.push({ file: shown, line: line + 1, column: character + 1, code: '', message })
    })
    diagnostics.push(...lintFound)
  } else {
    diagnostics.push({ file: shown, line: 0, column: 0, code: '', message: `${WORDS[kind].one.replace(/^an? /, 'The ')} could not be read.` })
  }
  diagnostics.sort((a, b) => a.line - b.line || a.column - b.column)
  const stamp = hashOf(source)
  if (diagnostics.length) {
    return { ok: false, file, stamp, diagnostics, text: formatDiagnostics(diagnostics), ms: Math.round(performance.now() - t0) }
  }
  const out = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      sourceMap: true,
      isolatedModules: true
    }
  })
  const code = out.outputText.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n')
  return { ok: true, file, stamp, code, map: out.sourceMapText, diagnostics: [], text: '', ms: Math.round(performance.now() - t0) }
}
