import { forwardRef } from 'react'

interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  id?: string
}

export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ checked, onChange, id }, ref) => {
    return (
      <button
        ref={ref}
        id={id}
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border border-white/30 bg-white/5 transition-all hover:border-white/50 focus-visible:outline-none"
      >
        {checked && (
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5 text-sky-400"
            fill="none"
            stroke="currentColor"
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </button>
    )
  }
)

Checkbox.displayName = 'Checkbox'
