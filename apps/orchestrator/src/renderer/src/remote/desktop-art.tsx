import { useId, type ReactNode } from 'react'
import { hostPicture, type HostKind, type HostPicture } from '@shared/remote-host-kind'
import { getMac, macHue } from './macs'

export type ArtTone = 'ok' | 'wait' | 'err' | 'off'

const BODY = '#3a3b40'
const BODY2 = '#56575d'
const FOOT = '#6c6d73'
const EDGE = 'rgb(255 255 255 / 0.18)'
const EDGE_GONE = 'rgb(239 110 107 / 0.8)'
const SHADE = 'rgb(0 0 0 / 0.3)'

interface Paint {
  screen: string
  edge: string
  dash: string | undefined
  glyph: string
  accent: string
  led: string
  lit: boolean
}

function Glare({ d, lit }: { d: string; lit: boolean }) {
  return lit ? <path d={d} stroke="rgb(255 255 255 / 0.28)" strokeWidth="1.4" strokeLinecap="round" fill="none" /> : null
}

function Panes({ x, y, p }: { x: number; y: number; p: Paint }) {
  const s = 3.1
  const g = 0.7
  return (
    <g fill={p.glyph}>
      <rect x={x - s - g / 2} y={y - s - g / 2} width={s} height={s} rx="0.4" />
      <rect x={x + g / 2} y={y - s - g / 2} width={s} height={s} rx="0.4" />
      <rect x={x - s - g / 2} y={y + g / 2} width={s} height={s} rx="0.4" />
      <rect x={x + g / 2} y={y + g / 2} width={s} height={s} rx="0.4" />
    </g>
  )
}

function Prompt({ x, y, p }: { x: number; y: number; p: Paint }) {
  return <path d={`M${x - 4.4} ${y - 3}l3.4 3-3.4 3M${x + 0.6} ${y + 3}h4.4`} stroke={p.glyph} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
}

function Generic({ p }: { p: Paint }) {
  return (
    <>
      <rect x="1" y="1" width="42" height="28" rx="5" fill={BODY} stroke={p.edge} strokeWidth="1" strokeDasharray={p.dash} />
      <rect x="3.5" y="3.5" width="37" height="23" rx="3" fill={p.screen} />
      <Glare d="M5 6.5c6-1.6 13-1.6 21 0" lit={p.lit} />
      <path d="M17 29h10l1.6 5.5H15.4z" fill={BODY2} />
      <rect x="12" y="34.2" width="20" height="2.6" rx="1.3" fill={FOOT} />
    </>
  )
}

function MacLaptop({ p }: { p: Paint }) {
  return (
    <g transform="translate(0 1.6)">
      <rect x="5" y="3.5" width="34" height="24.5" rx="3" fill={BODY} stroke={p.edge} strokeWidth="1" strokeDasharray={p.dash} />
      <rect x="6.8" y="5.3" width="30.4" height="20.9" rx="1.6" fill={p.screen} />
      <rect x="19.6" y="5.3" width="4.8" height="1.3" rx="0.6" fill={BODY} />
      <Glare d="M8.6 8c5-1.3 11-1.3 17.5 0" lit={p.lit} />
      <path d="M0.8 28.4h42.4v1.5a3.3 3.3 0 0 1-3.3 3.3H4.1a3.3 3.3 0 0 1-3.3-3.3z" fill={BODY2} />
      <rect x="17.5" y="28.4" width="9" height="1.4" rx="0.7" fill="#45464b" />
    </g>
  )
}

function IMac({ p }: { p: Paint }) {
  return (
    <>
      <rect x="1" y="1" width="42" height="29" rx="3" fill={p.accent} stroke={p.edge} strokeWidth="1" strokeDasharray={p.dash} />
      <rect x="1.9" y="1.9" width="40.2" height="21.6" rx="2.2" fill="#2c2d31" />
      <rect x="3.3" y="3.3" width="37.4" height="18.8" rx="1" fill={p.screen} />
      <Glare d="M5 6c6-1.5 13-1.5 21 0" lit={p.lit} />
      <path d="M18.6 30h6.8l1.4 5.1h-9.6z" fill={BODY2} />
      <rect x="14.5" y="34.6" width="15" height="2.2" rx="1.1" fill={FOOT} />
    </>
  )
}

function MacBox({ p }: { p: Paint }) {
  return (
    <g transform="translate(0 2.6)">
      <path d="M3 15h38v11.2a4.3 4.3 0 0 1-4.3 4.3H7.3A4.3 4.3 0 0 1 3 26.2z" fill={BODY} stroke={p.edge} strokeWidth="1" strokeDasharray={p.dash} />
      <rect x="3" y="4" width="38" height="15" rx="4.6" fill={p.screen} stroke={p.edge} strokeWidth="1" strokeDasharray={p.dash} />
      <Glare d="M7 7.2c7-1.2 15-1.2 24 0" lit={p.lit} />
      <circle cx="8.4" cy="24.6" r="1" fill={p.led} />
      <rect x="27.4" y="23.8" width="2" height="1.6" rx="0.5" fill={SHADE} />
      <rect x="30.8" y="23.8" width="2" height="1.6" rx="0.5" fill={SHADE} />
      <rect x="34.2" y="24.1" width="3.6" height="1" rx="0.5" fill={SHADE} />
    </g>
  )
}

function MacTower({ p }: { p: Paint }) {
  const holes: ReactNode[] = []
  for (let row = 0; row < 7; row++) {
    const odd = row % 2 === 1
    const cols = odd ? 3 : 4
    for (let c = 0; c < cols; c++) holes.push(<circle key={`${row}-${c}`} cx={(odd ? 17.4 : 15.2) + c * 4.4} cy={7.6 + row * 3.95} r="1.3" fill="rgb(0 0 0 / 0.34)" />)
  }
  return (
    <>
      <path d="M13.8 3.6V2.2a1.1 1.1 0 0 1 1.1-1.1h3.6a1.1 1.1 0 0 1 1.1 1.1v1.4M24.4 3.6V2.2a1.1 1.1 0 0 1 1.1-1.1h3.6a1.1 1.1 0 0 1 1.1 1.1v1.4" stroke={FOOT} strokeWidth="1.3" fill="none" />
      <rect x="11" y="3.2" width="22" height="31.6" rx="3.2" fill={BODY} stroke={p.edge} strokeWidth="1" strokeDasharray={p.dash} />
      <rect x="12.8" y="5" width="18.4" height="28" rx="2" fill={p.screen} />
      {holes}
      <rect x="12.6" y="34.8" width="3.4" height="1.8" rx="0.7" fill={FOOT} />
      <rect x="28" y="34.8" width="3.4" height="1.8" rx="0.7" fill={FOOT} />
    </>
  )
}

function PcLaptop({ p, glyph }: { p: Paint; glyph: 'panes' | 'prompt' }) {
  const round = glyph === 'prompt' ? 2.6 : 1.6
  return (
    <g transform="translate(0 1)">
      <rect x="5" y="2.5" width="34" height="24" rx={round} fill={BODY} stroke={p.edge} strokeWidth="1" strokeDasharray={p.dash} />
      <rect x="6.6" y="4.1" width="30.8" height="20.8" rx={round - 1} fill={p.screen} />
      <Glare d="M8.4 6.8c5-1.2 11-1.2 17 0" lit={p.lit} />
      {glyph === 'panes' ? <Panes x={22} y={14.5} p={p} /> : <Prompt x={21.4} y={14.5} p={p} />}
      <path d="M5 26.5h34l4.1 5.9a0.9 0.9 0 0 1-0.74 1.4H1.64a0.9 0.9 0 0 1-0.74-1.4z" fill={BODY2} />
      <path d="M8.8 27.9h26.4l1.7 2.5H7.1z" fill="rgb(0 0 0 / 0.22)" />
      <rect x="18.4" y="31.1" width="7.2" height="1.6" rx="0.5" fill="rgb(0 0 0 / 0.22)" />
    </g>
  )
}

function PcDesktop({ p, glyph }: { p: Paint; glyph: 'panes' | 'prompt' }) {
  const round = glyph === 'prompt' ? 2.6 : 1.6
  return (
    <>
      <rect x="32" y="5.5" width="11" height="30.5" rx={round - 0.4} fill={BODY} stroke={p.edge} strokeWidth="1" strokeDasharray={p.dash} />
      <circle cx="37.5" cy="9.6" r="1.25" fill={p.led} />
      <rect x="34.5" y="13.4" width="6" height="1.4" rx="0.5" fill={SHADE} />
      <path d="M34.6 26h5.8M34.6 28.4h5.8M34.6 30.8h5.8" stroke={SHADE} strokeWidth="1" strokeLinecap="round" />
      <rect x="1" y="2.5" width="29" height="21.5" rx={round} fill={BODY} stroke={p.edge} strokeWidth="1" strokeDasharray={p.dash} />
      <rect x="2.6" y="4.1" width="25.8" height="18.3" rx={round - 1} fill={p.screen} />
      <Glare d="M4.4 6.8c4-1.1 9-1.1 14.5 0" lit={p.lit} />
      {glyph === 'panes' ? <Panes x={15.5} y={13.25} p={p} /> : <Prompt x={14.9} y={13.25} p={p} />}
      <rect x="13.5" y="24" width="4" height="7.4" fill={BODY2} />
      <rect x="8.5" y="31" width="14" height="2.6" rx="1.3" fill={FOOT} />
    </>
  )
}

function Art({ picture, p }: { picture: HostPicture; p: Paint }) {
  if (picture === 'mac-laptop') return <MacLaptop p={p} />
  if (picture === 'imac') return <IMac p={p} />
  if (picture === 'mac-box') return <MacBox p={p} />
  if (picture === 'mac-tower') return <MacTower p={p} />
  if (picture === 'win-laptop') return <PcLaptop p={p} glyph="panes" />
  if (picture === 'win-desktop') return <PcDesktop p={p} glyph="panes" />
  if (picture === 'linux-laptop') return <PcLaptop p={p} glyph="prompt" />
  if (picture === 'linux-desktop') return <PcDesktop p={p} glyph="prompt" />
  return <Generic p={p} />
}

export function DesktopTile({ hostId, kind, size = 44, tone = 'ok', removed = false }: { hostId: string; kind?: HostKind | null; size?: number; tone?: ArtTone; removed?: boolean }) {
  const h = macHue(hostId)
  const lit = tone === 'ok' && !removed
  const id = `dt${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const k = kind === undefined ? getMac(hostId)?.kind ?? null : kind
  const picture = hostPicture(k)
  const paint: Paint = {
    screen: removed ? '#1d1e22' : `url(#${id})`,
    edge: removed ? EDGE_GONE : EDGE,
    dash: removed ? '3 2.5' : undefined,
    glyph: removed ? 'rgb(255 255 255 / 0.12)' : lit ? 'rgb(255 255 255 / 0.66)' : 'rgb(255 255 255 / 0.2)',
    accent: removed ? '#2a2b30' : lit ? `hsl(${h} 62% 56%)` : `hsl(${h} 14% 30%)`,
    led: removed ? '#2a2b30' : lit ? `hsl(${h} 90% 78%)` : 'rgb(255 255 255 / 0.16)',
    lit
  }
  return (
    <svg width={size} height={Math.round(size * 0.86)} viewBox="0 0 44 38" className="shrink-0" aria-hidden data-mac-tile={hostId} data-mac-lit={lit ? '1' : '0'} data-desktop-picture={picture}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={lit ? `hsl(${h} 78% 64%)` : `hsl(${h} 18% 30%)`} />
          <stop offset="1" stopColor={lit ? `hsl(${(h + 48) % 360} 70% 34%)` : `hsl(${(h + 48) % 360} 12% 17%)`} />
        </linearGradient>
      </defs>
      <Art picture={picture} p={paint} />
    </svg>
  )
}
