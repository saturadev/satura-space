interface ImportMeta {
  glob(pattern: string | string[], options: { query: '?raw'; import: 'default' }): Record<string, () => Promise<string>>
  glob(pattern: string | string[]): Record<string, () => Promise<unknown>>
  readonly env: { readonly DEV: boolean }
}
