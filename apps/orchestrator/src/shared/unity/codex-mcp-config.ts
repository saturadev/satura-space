function tomlBasicString(s: string): string {
  const esc = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${esc}"`
}

function codexServerBlock(
  serverName: string,
  command: string,
  args: string[],
  envVars: string[] = []
): string {
  const argList = args.map(tomlBasicString).join(', ')
  const envList = envVars.map(tomlBasicString).join(', ')
  const envLine = envVars.length ? `env_vars = [${envList}]\n` : ''
  const head = `[mcp_servers.${serverName}]\ncommand = ${tomlBasicString(command)}`
  return `${head}\nargs = [${argList}]\n${envLine}`
}

export function removeCodexMcpServer(content: string, serverName: string): string {
  const headerRe = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*$/
  const table = `mcp_servers.${serverName}`
  const quoted = `mcp_servers."${serverName}"`
  const lines = content.length ? content.split('\n') : []
  const kept: string[] = []
  let skipping = false
  for (const line of lines) {
    const m = headerRe.exec(line)
    if (m) {
      const key = m[1].trim()
      skipping =
        key === table ||
        key === quoted ||
        key.startsWith(`${table}.`) ||
        key.startsWith(`${quoted}.`)
    }
    if (!skipping) kept.push(line)
  }
  return kept.join('\n')
}

export function upsertCodexMcpServer(
  content: string,
  serverName: string,
  command: string,
  args: string[],
  envVars: string[] = []
): string {
  const base = removeCodexMcpServer(content, serverName).replace(/\n+$/, '')
  const block = codexServerBlock(serverName, command, args, envVars).replace(/\n+$/, '')
  const sep = base ? '\n\n' : ''
  return `${base}${sep}${block}\n`
}
