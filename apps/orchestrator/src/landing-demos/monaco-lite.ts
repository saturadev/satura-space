import 'monaco-editor/esm/vs/editor/edcore.main.js'
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js'

export * from 'monaco-editor/esm/vs/editor/edcore.main.js'

const noop = (): void => undefined

const defaults = {
  getCompilerOptions: (): Record<string, unknown> => ({}),
  setCompilerOptions: noop,
  setDiagnosticsOptions: noop
}

export const typescript = {
  typescriptDefaults: defaults,
  javascriptDefaults: defaults,
  JsxEmit: { Preserve: 1 }
}
