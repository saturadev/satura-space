import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname, userInfo } from 'node:os'
import { fileURLToPath } from 'node:url'

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
export const SHOWN_PROJECT = '/Users/dev/UnityProject'

function standIn(base, len) {
  let out = base
  while (out.length < len) out += base
  return out.slice(0, len)
}

export function scrubPersonal(json) {
  const host = hostname().replace(/\.local$/, '')
  const tokens = [
    [userInfo().username, 'studio-dev-user'],
    [host, 'Studio-iMac-Pro'],
    [host.replace(/-/g, ' '), 'Studio iMac Pro']
  ]
  let out = json
  for (const [token, base] of tokens) if (token && token.length > 2) out = out.split(token).join(standIn(base, token.length))
  return out
}

export async function tapStart(page, { calls = [], events = [] }) {
  await page.evaluate(
    async ({ calls, events }) => {
      const rec = (window.__landingTap = { t0: performance.now(), calls: {}, events: [], marks: [], offs: [] })
      for (const name of events) {
        const [ns, method] = name.split('.')
        rec.offs.push(
          window.api[ns][method]((...args) => rec.events.push({ t: Math.round(performance.now() - rec.t0), m: name, args }))
        )
      }
      for (const [ns, method, args] of calls) {
        rec.calls[`${ns}.${method}:${JSON.stringify(args)}`] = await window.api[ns][method](...args)
      }
    },
    { calls, events }
  )
}

export async function tapMark(page, label, data) {
  await page.evaluate(
    ({ label, data }) => {
      const rec = window.__landingTap
      if (rec) rec.marks.push({ t: Math.round(performance.now() - rec.t0), label, data })
    },
    { label, data }
  )
}

export async function tapCall(page, ns, method, args) {
  return page.evaluate(
    async ({ ns, method, args }) => {
      const rec = window.__landingTap
      const r = await window.api[ns][method](...args)
      if (rec) rec.calls[`${ns}.${method}:${JSON.stringify(args)}`] = r
      return r
    },
    { ns, method, args }
  )
}

export async function tapStop(page) {
  return page.evaluate(() => {
    const rec = window.__landingTap
    if (!rec) return null
    for (const off of rec.offs) off()
    delete window.__landingTap
    return { calls: rec.calls, events: rec.events, marks: rec.marks }
  })
}

export function writeTap(name, tap, { project, extra = {} } = {}) {
  mkdirSync(FIXTURES, { recursive: true })
  let json = JSON.stringify({ recordedAt: new Date().toISOString(), root: SHOWN_PROJECT, ...extra, ...tap })
  if (project) json = json.split(project).join(SHOWN_PROJECT)
  json = json.split(process.env.HOME ?? '/Users/unknown').join('/Users/dev')
  const user = userInfo().username
  const host = hostname().split('.')[0]
  if (user) json = json.split(user).join('gamedev-studio'.slice(0, user.length).padEnd(user.length, '0'))
  if (host) json = json.split(host).join('Studio-Mac-01'.slice(0, host.length).padEnd(host.length, '0'))
  const path = join(FIXTURES, `${name}.json`)
  writeFileSync(path, json)
  return { path, bytes: json.length }
}
