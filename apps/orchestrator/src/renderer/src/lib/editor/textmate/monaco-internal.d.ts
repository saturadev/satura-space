declare module 'monaco-editor/esm/vs/editor/common/languages.js' {
  export const TokenizationRegistry: {
    get(languageId: string): object | null
    handleChange(languageIds: string[]): void
    onDidChange(listener: (e: { changedLanguages: string[]; changedColorMap: boolean }) => void): { dispose(): void }
  }
}

declare module 'monaco-editor/esm/vs/basic-languages/typescript/typescript.js' {
  export const language: import('monaco-editor').languages.IMonarchLanguage
}

declare module 'monaco-editor/esm/vs/basic-languages/javascript/javascript.js' {
  export const language: import('monaco-editor').languages.IMonarchLanguage
}
