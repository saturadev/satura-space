import { Check, ChevronDown, Sparkles } from 'lucide-react'
import type { TunerViewEffects } from '../../lib/tuner/layout'
import { useToolbarMenu } from './useToolbarMenu'

type EffectKey = Exclude<keyof TunerViewEffects, 'enabled'>

const ITEMS: { key: EffectKey; label: string }[] = [
  { key: 'skybox', label: 'Skybox' },
  { key: 'fog', label: 'Fog' },
  { key: 'refresh', label: 'Always Refresh' },
  { key: 'post', label: 'Post Processing' },
  { key: 'particles', label: 'Particle Systems' }
]

export function SceneEffectsMenu({
  effects,
  onChange,
  buttonClass
}: {
  effects: TunerViewEffects
  onChange: (next: TunerViewEffects) => void
  buttonClass: (on: boolean) => string
}) {
  const { open, setOpen, rootRef, menuRef } = useToolbarMenu()

  const toggle = (): void => {
    setOpen((o) => !o)
  }

  return (
    <div ref={rootRef} className="relative flex items-center" data-scene-effects={effects.enabled ? 'on' : 'off'}>
      <button
        type="button"
        aria-pressed={effects.enabled}
        aria-label="Effects"
        className={`${buttonClass(effects.enabled)} rounded-r-none pr-1`}
        onClick={() => onChange({ ...effects, enabled: !effects.enabled })}
        data-ti-tip={effects.enabled ? 'Scene effects are on. Click to turn them all off.' : 'Scene effects are off. Click to turn them on.'}
      >
        <Sparkles className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="Effects menu"
        aria-expanded={open}
        className={`${buttonClass(open || effects.enabled)} rounded-l-none px-0.5`}
        onClick={toggle}
        data-ti-tip="Choose which effects the scene view draws"
      >
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div
          role="menu"
          ref={menuRef}
          data-scene-effects-menu
          style={{ left: 0, top: 0 }}
          className="surface-overlay fixed z-40 w-44 rounded-lg py-1"
        >
          {ITEMS.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitemcheckbox"
              aria-checked={effects[it.key]}
              data-scene-effect={it.key}
              disabled={!effects.enabled}
              onClick={() => onChange({ ...effects, [it.key]: !effects[it.key] })}
              className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[11px] text-zinc-200 hover:bg-white/10 disabled:opacity-40"
            >
              <span className="flex h-3.5 w-3.5 items-center justify-center">
                {effects[it.key] && <Check className="h-3 w-3 text-sky-300" />}
              </span>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
