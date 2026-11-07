import type { ReactNode, SVGProps } from 'react'

export type EnvIconProps = Omit<SVGProps<SVGSVGElement>, 'ref' | 'children'> & { size?: number | string }

function EnvIcon({ size = 24, strokeWidth = 2, children, ...rest }: EnvIconProps & { children?: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <rect x="3" y="3" width="18" height="13" rx="2" />
      <path d="M2 20h20" />
      {children}
    </svg>
  )
}

export function EnvFileIcon(props: EnvIconProps) {
  return <EnvIcon {...props} />
}

export function EnvAddIcon(props: EnvIconProps) {
  return (
    <EnvIcon {...props}>
      <path d="M12 6.5v6" />
      <path d="M9 9.5h6" />
    </EnvIcon>
  )
}

export function EnvWarningIcon(props: EnvIconProps) {
  return (
    <EnvIcon {...props}>
      <path d="M12 6v3.5" />
      <path d="M12 12.5h.01" />
    </EnvIcon>
  )
}

export function EnvKeepIcon(props: EnvIconProps) {
  return (
    <EnvIcon {...props}>
      <path d="m8.5 9.5 2.5 2.5 4.5-4.5" />
    </EnvIcon>
  )
}
