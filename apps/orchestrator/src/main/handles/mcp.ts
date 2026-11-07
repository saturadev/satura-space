import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { repoPackagePath } from '../bundled-resources'
import { defineHandle } from './registry'
import { inJail, jailRoot, scratchFor, treeOf } from './scratch'
import { fakeOf } from './fake'

function pathStrings(v: unknown, out: string[]): string[] {
  if (typeof v === 'string') {
    if (!v.includes('\n') && v.length < 4096 && isAbsolute(v)) out.push(v)
  } else if (Array.isArray(v)) for (const x of v) pathStrings(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) pathStrings(x, out)
  return out
}

defineHandle({
  name: 'mcp.call',
  side: 'main',
  agentOnly: true,
  description:
    "Calls one function of the MCP server's Python package (packages/mcp/unity_mcp) in a fresh packages/mcp/.venv python, with JSON args, inside a scratch project: the working directory and HOME are the scratch dir, the app's endpoint env is not passed on, and every absolute path in args and kwargs must be inside the temp jail. Reaches the MCP's failure paths without a live editor: file_lock.stale_holder / project_editor_lock with a stale .sspace/.mcp_exec.lock.owner, instances._lockfile_state, proc_identity checks and pid reuse, command_log.enqueue / enqueue_retry, multiplayer.request_player_command and its socket errors, sspace.ensure_sspace (the .sspace/.gitignore merge), tools_env helpers. module is the unity_mcp module (file_lock, command_log, ...), fn the function or Class.method; fn: '' lists the module's functions with their signatures. args and kwargs are JSON, with {\"$path\": p} for a pathlib.Path, {\"$tuple\": [...]} and {\"$bytes\": base64}; coroutines are awaited. project: '' makes a scratch project (or pass a scratch.dir root), seed writes files into it first. app: <fake.start ndjson id> writes .sspace/.mcp_orchestrator.json pointing at that fake with this app's pid, so the MCP believes Satura Space manages the project and talks to the fake's control socket. env adds variables. Returns ok, value (dataclasses, Paths and sets made JSON), or error with its traceback, the function's stdout and stderr (logging included), ms, the project and its files afterwards.",
  params: { module: '', fn: '', args: [] as unknown[], kwargs: {}, project: '', seed: {}, app: '', env: {}, timeoutMs: 30_000, keep: false },
  async run(p, ctx) {
    const mcpDir = repoPackagePath('mcp')
    const python = join(mcpDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    if (!existsSync(python)) throw new Error(`No MCP venv at ${python}. Set it up with packages/mcp/run.sh.`)
    const outside = pathStrings([p.args, p.kwargs], []).filter((x) => !inJail(x))
    if (outside.length) throw new Error(`mcp.call only passes paths inside ${jailRoot()}. Outside: ${outside.slice(0, 5).join(', ')}.`)
    const s = scratchFor({ root: p.project, keep: p.keep }, ctx, 'mcp project')
    const seed = (p.seed ?? {}) as Record<string, unknown>
    for (const [rel, body] of Object.entries(seed)) {
      const file = join(s.root, rel)
      if (!inJail(file)) throw new Error(`seed ${rel} is outside the scratch project.`)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
    }
    if (p.app) {
      const fake = fakeOf(p.app)
      if (fake.kind !== 'ndjson') throw new Error('app must be a fake.start kind: ndjson fake.')
      mkdirSync(join(s.root, '.sspace'), { recursive: true })
      writeFileSync(join(s.root, '.sspace', '.mcp_orchestrator.json'), JSON.stringify({ pid: process.pid, controlPort: fake.port, controlToken: fake.token, projectRoot: s.root }))
      ctx.log(`${s.root}/.sspace/.mcp_orchestrator.json -> ${fake.url} (pid ${process.pid})`)
    }
    const timeoutMs = Math.max(500, Math.min(300_000, Number(p.timeoutMs) || 30_000))
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: s.root,
      PYTHONPATH: mcpDir,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONIOENCODING: 'utf-8',
      ...(process.platform === 'win32' ? { SYSTEMROOT: process.env.SYSTEMROOT ?? 'C:\\Windows' } : {})
    }
    for (const [k, v] of Object.entries((p.env ?? {}) as Record<string, unknown>)) env[k] = String(v)
    const req = { module: String(p.module ?? ''), fn: String(p.fn ?? ''), args: Array.isArray(p.args) ? p.args : [p.args], kwargs: p.kwargs ?? {}, timeout: timeoutMs / 1000 }
    ctx.log(`unity_mcp.${req.module}.${req.fn || '(list)'} in ${s.root}`)
    const t0 = Date.now()
    const reply = await new Promise<Record<string, unknown>>((done) => {
      const child = spawn(python, ['-P', '-m', 'unity_mcp.probe'], { cwd: s.root, env, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (c: string) => (out += c))
      child.stderr.on('data', (c: string) => (err += c))
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 5000)
      child.on('error', (e) => done({ ok: false, error: { name: 'SpawnError', message: e.message } }))
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        const line = out.trim().split('\n').pop() ?? ''
        try {
          done({ ...(JSON.parse(line) as Record<string, unknown>), ...(err.trim() ? { processStderr: err.trim().slice(-4000) } : {}) })
        } catch {
          done({ ok: false, error: { name: 'NoReply', message: `python exited with ${code ?? signal} and no reply` }, processStdout: out.slice(-4000), processStderr: err.slice(-4000) })
        }
      })
      child.stdin.end(JSON.stringify(req))
    })
    ctx.log(`${req.fn || '(list)'} ${reply.ok ? 'returned' : `failed: ${(reply.error as { message?: string })?.message ?? ''}`.slice(0, 200)} in ${Date.now() - t0} ms`)
    return { ...reply, project: s.root, id: s.id, files: treeOf(s.root, { read: true }).filter((e) => !e.path.startsWith('__pycache__')) }
  }
})
