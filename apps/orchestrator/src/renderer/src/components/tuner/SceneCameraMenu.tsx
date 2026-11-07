import { useEffect, useState, type ReactNode } from 'react'
import { Camera } from 'lucide-react'
import { CAMERA_LIMITS, DEFAULT_TUNER_CAMERA, sanitizeCameraSettings, type TunerCameraSettings } from '../../lib/tuner/layout'
import { useToolbarMenu } from './useToolbarMenu'

type NumKey = { [K in keyof TunerCameraSettings]: TunerCameraSettings[K] extends number ? K : never }[keyof TunerCameraSettings]
type BoolKey = { [K in keyof TunerCameraSettings]: TunerCameraSettings[K] extends boolean ? K : never }[keyof TunerCameraSettings]

function fmt(v: number): string {
  if (v === 0) return '0'
  const a = Math.abs(v)
  if (a >= 1000 || a < 0.001) return String(Number(v.toPrecision(4)))
  return String(Number(v.toFixed(a < 1 ? 4 : 2)))
}

function NumberBox({ value, onCommit, disabled, cam }: { value: number; onCommit: (v: number) => void; disabled?: boolean; cam: string }) {
  const [text, setText] = useState(fmt(value))
  useEffect(() => setText(fmt(value)), [value])
  const commit = (): void => {
    const v = Number(text)
    if (Number.isFinite(v)) onCommit(v)
    else setText(fmt(value))
  }
  return (
    <input
      data-scene-camera-field={cam}
      disabled={disabled}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
      }}
      className="h-5 w-14 shrink-0 rounded border border-white/10 bg-black/30 px-1 text-right text-[11px] text-zinc-200 outline-none focus:border-sky-400/60 disabled:opacity-40"
    />
  )
}

function Row({ label, children, disabled }: { label: string; children: ReactNode; disabled?: boolean }) {
  return (
    <div className={`flex items-center gap-2 px-2.5 py-0.5 text-[11px] text-zinc-200 ${disabled ? 'opacity-40' : ''}`}>
      <span className="w-[124px] shrink-0 truncate">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  )
}

export function SceneCameraMenu({
  camera,
  onChange,
  buttonClass
}: {
  camera: TunerCameraSettings
  onChange: (next: TunerCameraSettings) => void
  buttonClass: (on: boolean) => string
}) {
  const { open, setOpen, rootRef, menuRef } = useToolbarMenu()

  const set = (patch: Partial<TunerCameraSettings>): void => onChange(sanitizeCameraSettings({ ...camera, ...patch }))

  const slider = (key: NumKey, min: number, max: number, step: number, disabled?: boolean) => (
    <>
      <input
        type="range"
        data-scene-camera-slider={key}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={Math.max(min, Math.min(max, camera[key]))}
        onChange={(e) => set({ [key]: Number(e.target.value) })}
        className="h-1 min-w-0 flex-1 accent-sky-400 disabled:opacity-40"
      />
      <NumberBox cam={key} value={camera[key]} disabled={disabled} onCommit={(v) => set({ [key]: v })} />
    </>
  )

  const toggle = (key: BoolKey) => (
    <input
      type="checkbox"
      data-scene-camera-toggle={key}
      checked={camera[key]}
      onChange={(e) => set({ [key]: e.target.checked })}
      className="h-3 w-3 accent-sky-400"
    />
  )

  return (
    <div ref={rootRef} className="relative flex items-center" data-scene-camera-menu-root>
      <button
        type="button"
        aria-label="Scene camera"
        aria-expanded={open}
        className={buttonClass(open)}
        onClick={() => setOpen((o) => !o)}
        data-ti-tip="Scene camera settings"
      >
        <Camera className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div ref={menuRef} data-scene-camera-menu style={{ left: 0, top: 0 }} className="surface-overlay fixed z-40 w-[320px] rounded-lg py-1.5">
          <div className="flex items-center justify-between px-2.5 pb-1 text-[11px] font-semibold text-zinc-100">
            <span>Scene Camera</span>
            <button
              type="button"
              data-scene-camera-reset
              onClick={() => onChange({ ...DEFAULT_TUNER_CAMERA })}
              className="rounded px-1.5 text-[10px] font-normal text-zinc-400 hover:bg-white/10 hover:text-zinc-200"
            >
              Reset Settings
            </button>
          </div>
          <Row label="Field of View">{slider('fov', CAMERA_LIMITS.fov[0], CAMERA_LIMITS.fov[1], 0.1)}</Row>
          <Row label="Dynamic Clipping">{toggle('dynamicClip')}</Row>
          <Row label="Clipping Planes" disabled={camera.dynamicClip}>
            <span className="text-zinc-400">Near</span>
            <NumberBox cam="near" value={camera.near} disabled={camera.dynamicClip} onCommit={(near) => set({ near })} />
            <span className="text-zinc-400">Far</span>
            <NumberBox cam="far" value={camera.far} disabled={camera.dynamicClip} onCommit={(far) => set({ far })} />
          </Row>
          <div className="mx-2.5 my-1 h-px bg-white/10" />
          <div className="px-2.5 pb-0.5 text-[11px] font-semibold text-zinc-100">Navigation</div>
          <Row label="Camera Easing">{toggle('easing')}</Row>
          <Row label="Duration" disabled={!camera.easing}>
            {slider('easingDuration', CAMERA_LIMITS.easingDuration[0], CAMERA_LIMITS.easingDuration[1], 0.01, !camera.easing)}
          </Row>
          <Row label="Camera Acceleration">{toggle('acceleration')}</Row>
          <Row label="Acceleration" disabled={!camera.acceleration}>
            {slider('accelerationSpeed', CAMERA_LIMITS.accelerationSpeed[0], CAMERA_LIMITS.accelerationSpeed[1], 0.01, !camera.acceleration)}
          </Row>
          <Row label="Camera Speed">{slider('speed', camera.speedMin, camera.speedMax, (camera.speedMax - camera.speedMin) / 200)}</Row>
          <Row label="">
            <span className="text-zinc-400">Min</span>
            <NumberBox cam="speedMin" value={camera.speedMin} onCommit={(speedMin) => set({ speedMin })} />
            <span className="text-zinc-400">Max</span>
            <NumberBox cam="speedMax" value={camera.speedMax} onCommit={(speedMax) => set({ speedMax })} />
          </Row>
          <Row label="Shift Multiplier">{slider('speedModifier', CAMERA_LIMITS.speedModifier[0], CAMERA_LIMITS.speedModifier[1], 0.1)}</Row>
        </div>
      )}
    </div>
  )
}
