import { useAppStore } from '../../store'
import { UsageButton } from './UsageButton'

export function KimiIcon({ size }: { size: number }) {
  return (
    <svg
      height={size}
      width={size}
      viewBox="0 0 24 24"
      className="shrink-0"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
        fill="currentColor"
        fillRule="nonzero"
      />
    </svg>
  )
}

export function KimiUsageButton() {
  const remaining = useAppStore((s) => s.kimiUsageRemaining)
  const loading = useAppStore((s) => s.kimiUsageRemainingLoading)
  const fetchRemaining = useAppStore((s) => s.fetchKimiUsageRemaining)

  return (
    <UsageButton
      data={remaining}
      loading={loading}
      fetchRemaining={fetchRemaining}
      icon={(size) => <KimiIcon size={size} />}
      brandColor="#8B8FF7"
      title="Kimi usage left"
      unavailableHint="Not signed in to Kimi Code — run `kimi` to sign in."
      shortHint="Usage"
      freshnessVerb="Updated"
    />
  )
}
