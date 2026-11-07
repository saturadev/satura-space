import { useId, type ReactElement } from 'react'

interface UnityIconProps {
  className?: string
  size?: number | string
  strokeWidth?: number
  absoluteStrokeWidth?: boolean
  'aria-hidden'?: boolean
}

const TOP = 'M8 1 14.6 4.6 8 8.2 1.4 4.6Z'
const LEFT = 'M1.4 5.5 7.5 8.9V15.4L1.4 11.9Z'
const RIGHT = 'M14.6 5.5 8.5 8.9V15.4L14.6 11.9Z'

export function UnitySceneIcon({ className, size = 16 }: UnityIconProps): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} fill="currentColor" aria-hidden>
      <path d="M8 7.5 11.5 9.25 8 11 4.5 9.25Z" opacity={0.5} />
      <path d="M11.5 9.25 15 11 11.5 12.75 8 11Z" opacity={0.26} />
      <path d="M8 11 11.5 12.75 8 14.5 4.5 12.75Z" opacity={0.5} />
      <path d="M4.5 9.25 8 11 4.5 12.75 1 11Z" opacity={0.26} />
      <path d="M1 11 8 14.5v1.3L1 12.3Z" opacity={0.6} />
      <path d="M8 14.5 15 11v1.3l-7 3.5Z" opacity={0.4} />
      <path d="M5 3.2 8.5 4.95 5 6.7 1.5 4.95Z" />
      <path d="M1.5 4.95 5 6.7v3.6L1.5 8.55Z" opacity={0.72} />
      <path d="M5 6.7 8.5 4.95v3.6L5 10.3Z" opacity={0.46} />
      <path d="M13.62 5.88A3 3 0 0 0 9.38 10.12 3.75 3.75 0 0 0 13.62 5.88Z" />
      <path d="M13.62 5.88A3 3 0 0 1 9.38 10.12 3.75 3.75 0 0 0 13.62 5.88Z" opacity={0.46} />
    </svg>
  )
}

export function UnityPrefabIcon({ className, size = 16 }: UnityIconProps): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} fill="currentColor" aria-hidden>
      <path d={TOP} />
      <path d={LEFT} opacity={0.72} />
      <path d={RIGHT} opacity={0.46} />
    </svg>
  )
}

export function UnityStagingPrefabIcon({ className, size = 16 }: UnityIconProps): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} fill="currentColor" aria-hidden>
      <g transform="translate(3.4 0.2) scale(0.575)">
        <path d={TOP} />
        <path d={LEFT} opacity={0.72} />
        <path d={RIGHT} opacity={0.46} />
      </g>
      <ellipse cx={8} cy={11.6} rx={6.8} ry={2.1} opacity={0.45} />
      <path d="M1.2 11.6v1.5c0 1.16 3.04 2.1 6.8 2.1s6.8-.94 6.8-2.1v-1.5c0 1.16-3.04 2.1-6.8 2.1s-6.8-.94-6.8-2.1z" opacity={0.8} />
    </svg>
  )
}

export function UnityPrefabVariantIcon({ className, size = 16 }: UnityIconProps): ReactElement {
  const clip = `pv${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} fill="currentColor" aria-hidden>
      <defs>
        <clipPath id={clip}>
          <path d={LEFT} />
          <path d={RIGHT} />
        </clipPath>
      </defs>
      <path d={TOP} />
      <path d={LEFT} opacity={0.35} />
      <path d={RIGHT} opacity={0.25} />
      <g clipPath={`url(#${clip})`} stroke="currentColor" strokeWidth={1.3} fill="none">
        <path d="M-2 12 10 0M1.5 15.5 13.5 3.5M5 19 17 7M8.5 22.5 20.5 10.5" />
      </g>
    </svg>
  )
}

export function UnityPrefabAddedBadge({ className }: { className?: string }): ReactElement {
  return (
    <svg viewBox="0 0 10 10" width={8} height={8} className={className} aria-hidden>
      <circle cx="5" cy="5" r="4.6" fill="#17181a" />
      <circle cx="5" cy="5" r="3.7" fill="#3fd665" />
      <path d="M5 2.9v4.2M2.9 5h4.2" stroke="#101112" strokeWidth="1.3" />
    </svg>
  )
}
