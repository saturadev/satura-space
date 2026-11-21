import { AbsoluteFill, Loop, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { loadFont as loadInterTight } from '@remotion/google-fonts/InterTight'
import { loadFont as loadArchivo } from '@remotion/google-fonts/Archivo'

const interTight = loadInterTight('normal', { weights: ['800'] })
const archivo = loadArchivo('normal', { weights: ['900'] })

export const FPS = 30
const MAX_SECONDS = 60
const END_SECONDS = 2.5

export type ClipVsGameProps = {
  clipFile: string
  gameFile: string
  clipSeconds: number
  clipWidth: number
  clipHeight: number
  gameSeconds: number
  gameWidth: number
  gameHeight: number
  layout: 'side' | 'stack'
  title: string
  credit: string
  sound: 'game' | 'clip' | 'none'
  endCard: boolean
}

const bloom = 'linear-gradient(100deg,#e58a63 0%,#f6c560 30%,#84d98f 55%,#7ed3c2 76%,#92bff9 100%)'
const ink = '#15140f'
const ink3 = '#8c8a80'
const canvas = '#f7f7f4'

export const mainFrames = (p: ClipVsGameProps): number =>
  Math.max(FPS, Math.round(Math.min(Math.max(p.clipSeconds, p.gameSeconds), MAX_SECONDS) * FPS))

export const totalFrames = (p: ClipVsGameProps): number => mainFrames(p) + (p.endCard ? Math.round(END_SECONDS * FPS) : 0)

export const canvasFor = (p: ClipVsGameProps): { width: number; height: number } =>
  p.layout === 'stack' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 }

type Box = { width: number; height: number }

const boxes = (p: ClipVsGameProps): { clip: Box; game: Box } => {
  const ac = p.clipWidth / p.clipHeight
  const ag = p.gameWidth / p.gameHeight
  if (p.layout === 'stack') {
    const w = Math.min(960, 1220 / (1 / ac + 1 / ag))
    return { clip: { width: w, height: w / ac }, game: { width: w, height: w / ag } }
  }
  const h = Math.min(780, 1560 / (ac + ag))
  return { clip: { width: h * ac, height: h }, game: { width: h * ag, height: h } }
}

const Card = ({ src, box, label, loopFrames, muted, delay }: { src: string; box: Box; label: string; loopFrames: number; muted: boolean; delay: number }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const enter = spring({ frame: frame - delay, fps, config: { damping: 200 } })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 18, opacity: enter, transform: `translateY(${(1 - enter) * 40}px)` }}>
      <div
        style={{
          fontFamily: interTight.fontFamily,
          fontWeight: 800,
          fontSize: 30,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: ink3
        }}
      >
        {label}
      </div>
      <div style={{ width: box.width, height: box.height, position: 'relative', borderRadius: 28, overflow: 'hidden', background: '#000', boxShadow: '0 24px 60px rgba(20,18,11,.18)' }}>
        <Loop durationInFrames={loopFrames} layout="none">
          <OffthreadVideo src={staticFile(src)} muted={muted} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </Loop>
      </div>
    </div>
  )
}

const Arrow = ({ vertical }: { vertical: boolean }) => (
  <div
    style={{
      width: 84,
      height: 84,
      borderRadius: 42,
      background: bloom,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      transform: vertical ? 'rotate(90deg)' : undefined
    }}
  >
    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke={ink} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  </div>
)

const EndCard = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const enter = spring({ frame, fps, config: { damping: 200 } })
  return (
    <AbsoluteFill style={{ background: canvas, alignItems: 'center', justifyContent: 'center', gap: 28, opacity: enter }}>
      <div style={{ fontFamily: archivo.fontFamily, fontWeight: 900, fontSize: 120, letterSpacing: '-0.02em', color: ink, textTransform: 'uppercase' }}>Satura Space</div>
      <div style={{ height: 8, width: 420, borderRadius: 4, background: bloom }} />
      <div style={{ fontFamily: interTight.fontFamily, fontWeight: 800, fontSize: 44, color: ink }}>FREE & Open Source</div>
    </AbsoluteFill>
  )
}

export const ClipVsGame = (p: ClipVsGameProps) => {
  const frame = useCurrentFrame()
  const main = mainFrames(p)
  const { clip, game } = boxes(p)
  const vertical = p.layout === 'stack'
  const fadeOut = p.endCard ? interpolate(frame, [main - 8, main], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1
  const clipLoop = Math.max(1, Math.round(p.clipSeconds * FPS))
  const gameLoop = Math.max(1, Math.round(p.gameSeconds * FPS))
  return (
    <AbsoluteFill style={{ background: canvas }}>
      <AbsoluteFill style={{ opacity: fadeOut }}>
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: vertical ? 40 : 56, flexDirection: vertical ? 'column' : 'row', paddingTop: p.title ? (vertical ? 120 : 100) : 0, paddingBottom: p.credit ? 70 : 0 }}>
          <Card src={p.clipFile} box={clip} label="The clip" loopFrames={clipLoop} muted={p.sound !== 'clip'} delay={0} />
          <Arrow vertical={vertical} />
          <Card src={p.gameFile} box={game} label="The game" loopFrames={gameLoop} muted={p.sound !== 'game'} delay={6} />
        </AbsoluteFill>
        {p.title ? (
          <div style={{ position: 'absolute', top: vertical ? 80 : 56, left: 0, right: 0, textAlign: 'center', fontFamily: interTight.fontFamily, fontWeight: 800, fontSize: vertical ? 64 : 58, color: ink }}>{p.title}</div>
        ) : null}
        {p.credit ? (
          <div style={{ position: 'absolute', bottom: vertical ? 64 : 34, left: 0, right: 0, textAlign: 'center', fontFamily: interTight.fontFamily, fontWeight: 800, fontSize: 30, color: ink3 }}>{p.credit}</div>
        ) : null}
      </AbsoluteFill>
      {p.endCard ? (
        <Sequence from={main}>
          <EndCard />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  )
}
