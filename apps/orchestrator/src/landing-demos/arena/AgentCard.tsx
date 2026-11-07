import { useEffect, useRef, useState } from 'react'
import type { HandoffCard } from './handoff'

const TUNE = {
  ask: 'the motes are hard to see from the door, and the lights feel off. can you look?',
  says: "That's a call for your eye, not mine. I'll set the scene up so you can tune it.",
  name: ["name: 'motes-and-lights',"],
  objects: ['objects: [', "  { path: 'Monolith/Motes',", "    components: ['ParticleSystem'] },", "  { path: '**', components: ['Light'] }", '],'],
  fields: [
    'objects: [',
    "  { path: 'Monolith/Motes', components: [{",
    "    type: 'ParticleSystem', fields: [",
    "      'InitialModule.startSize',",
    "      'InitialModule.startColor',",
    "      'EmissionModule.rateOverTime',",
    "      'ShapeModule.angle'] }] },",
    "  { path: '**', components: [{",
    "    type: 'Light',",
    "    fields: ['m_Intensity', 'm_Color'] }] }",
    '],'
  ],
  camera: ['camera: { position: [0, 1.7, -9], lookAt: [0, 1.4, 0] }'],
  grey: '5 of 32 objects. The rest of the scene goes gray.',
  over: 'Over to you. Make the motes bigger and warmer until they read from the door, then press Copy Changes.',
  drift: "I'll have Drift show you. Click anywhere if you'd rather try it yourself.",
  reply: "Got it. I'll write those values into the scene."
}

const ANIM = {
  ask: 'the monolith rises too fast at the end. can you slow the rise down?',
  says: 'I opened the Arrival clip on the monolith. You can set the timing yourself.',
  code: ["tuner.open({ object: 'Monolith',", "  animator: { path: 'Monolith', clip: 'MonolithArrival' } })"],
  lines: ['Monolith › Animator › MonolithArrival › Slab Position, Scale'],
  reply: "Thanks. I'll keep that timing and save the clip."
}

const FREE = 'The filter is off and the whole scene is yours. Select anything, then press Ask Drift and Drift explains it.'

function Line({ mark, tone, children }: { mark: string; tone: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className={`shrink-0 ${tone}`}>{mark}</span>
      <span className="min-w-0 whitespace-pre-wrap break-words">{children}</span>
    </div>
  )
}

function Code({ k, lines, show = true, indent = 0 }: { k?: string; lines: string[]; show?: boolean; indent?: number }) {
  if (!show) return null
  return (
    <div data-demo-arg={k} className={k ? 'demo-arg' : undefined}>
      {lines.map((l, i) => {
        const pad = indent + (l.length - l.trimStart().length)
        return (
          <div key={i} data-demo-code-line className="whitespace-pre-wrap break-words text-[0.92em] leading-[1.45] text-zinc-300" style={{ paddingLeft: `${pad + 2}ch`, textIndent: '-2ch' }}>
            {l.trimStart()}
          </div>
        )
      })}
    </div>
  )
}

function useTyped(text: string, on: boolean, ms = 1700): string {
  const [n, setN] = useState(on ? 0 : text.length)
  useEffect(() => {
    if (!on) {
      setN(text.length)
      return
    }
    setN(0)
    const t0 = performance.now()
    let raf = 0
    const tick = (): void => {
      const k = Math.min(1, (performance.now() - t0) / ms)
      setN(Math.round(text.length * k))
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [text, on, ms])
  return text.slice(0, n)
}

export function AgentCard({
  card,
  free,
  phone = false
}: {
  card: HandoffCard
  free: boolean
  phone?: boolean
}) {
  const body = useRef<HTMLDivElement>(null)
  const tune = card.kind === 'tune'
  const ask = tune ? TUNE.ask : ANIM.ask
  const typed = useTyped(ask, tune && card.stage === 'ask')
  const at = (s: HandoffCard['stage'][]): boolean => s.includes(card.stage)
  const after = (s: HandoffCard['stage']): boolean => {
    const order: HandoffCard['stage'][] = ['idle', 'ask', 'agent', 'tool', 'tuning', 'yours', 'drift', 'sent']
    return order.indexOf(card.stage) >= order.indexOf(s)
  }
  useEffect(() => {
    const el = body.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [card.stage, card.beat, card.replied, typed.length > 0])
  return (
    <div
      data-demo-agent={free ? 'free' : card.stage}
      data-demo-agent-kind={card.kind}
      data-demo-phone={phone || undefined}
      className={`absolute inset-0 flex flex-col overflow-hidden bg-editor-surface font-mono text-[#d9dce1] ${phone ? 'text-[12px] leading-[16px]' : 'text-[14px] leading-[19px]'}`}
    >
      <div ref={body} className={`min-h-0 flex-1 overflow-y-auto py-2 pl-2 pr-3 ${phone ? 'space-y-1.5' : 'space-y-2'}`}>
        {free ? (
          <Line mark="●" tone="text-emerald-300">
            {FREE}
          </Line>
        ) : (
          <>
            {after('ask') && (
              <Line mark=">" tone="text-zinc-500">
                <span className="text-zinc-300">{tune ? typed : ask}</span>
                {tune && card.stage === 'ask' && <span className="demo-caret" />}
              </Line>
            )}
            {after('agent') && (
              <Line mark="●" tone="text-emerald-300">
                {tune ? TUNE.says : ANIM.says}
              </Line>
            )}
            {tune && after('tool') && (
              <div className="space-y-0.5">
                <Line mark="●" tone="text-sky-300">
                  <span className="text-zinc-100">satura_exec</span>
                </Line>
                <div className="pl-4">
                  <Code lines={['tuner.open({']} />
                  <Code k="name" lines={TUNE.name} show={card.beat >= 1} indent={2} />
                  {card.beat >= 4 ? <Code key="fields" k="fields" lines={TUNE.fields} indent={2} /> : <Code key="objects" k="objects" lines={TUNE.objects} show={card.beat >= 1} indent={2} />}
                  <Code k="camera" lines={TUNE.camera} show={card.beat >= 3} indent={2} />
                  <Code lines={['})']} />
                </div>
                {card.beat >= 2 && (
                  <div data-demo-arg="result" className="demo-arg flex gap-2 pl-4 text-zinc-400">
                    <span className="text-zinc-600">⎿</span>
                    <span>{TUNE.grey}</span>
                  </div>
                )}
              </div>
            )}
            {!tune && after('tool') && (
              <div className="space-y-0.5">
                <Line mark="●" tone="text-sky-300">
                  <span className="text-zinc-100">satura_exec</span>
                </Line>
                <div className="pl-4">
                  <Code lines={ANIM.code} />
                </div>
                {ANIM.lines.map((l, i) => (
                  <div key={i} className="flex gap-2 pl-4 text-zinc-400">
                    <span className="text-zinc-600">⎿</span>
                    <span>{l}</span>
                  </div>
                ))}
              </div>
            )}
            {tune && after('yours') && (
              <Line mark="●" tone="text-emerald-300">
                {TUNE.over}
              </Line>
            )}
            {tune && at(['drift']) && (
              <Line mark="●" tone="text-emerald-300">
                {TUNE.drift}
              </Line>
            )}
            {card.stage === 'sent' && (
              <>
                <Line mark=">" tone="text-zinc-500">
                  <span className="text-amber-100/90">{card.prompt || 'No values changed.'}</span>
                </Line>
                {card.replied && (
                  <Line mark="●" tone="text-emerald-300">
                    <span data-demo-reply>{tune ? TUNE.reply : ANIM.reply}</span>
                  </Line>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
