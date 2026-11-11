interface ImportMeta {
  glob(pattern: string | string[], options: { query: '?raw'; import: 'default' }): Record<string, () => Promise<string>>
  glob(pattern: string | string[]): Record<string, () => Promise<unknown>>
  glob<T>(pattern: string | string[], options: { eager: true; import: 'default' }): Record<string, T>
  readonly env: { readonly DEV: boolean }
}
