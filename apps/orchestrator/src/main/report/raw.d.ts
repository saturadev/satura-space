declare module '*?raw' {
  const source: string
  export default source
}

interface ImportMeta {
  glob(pattern: string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>
}
