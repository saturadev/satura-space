import chimeSuccess from '../../assets/sounds/chime-success.wav'
import chimeInfo from '../../assets/sounds/chime-info.wav'
import chimeWarning from '../../assets/sounds/chime-warning.wav'

export interface SoundOption {
  id: string
  label: string
  group: string
  url: string
}

export const SOUND_OPTIONS: SoundOption[] = [
  { id: 'chime-success', label: 'Success', group: 'Chime', url: chimeSuccess },
  { id: 'chime-info', label: 'Info', group: 'Chime', url: chimeInfo },
  { id: 'chime-warning', label: 'Warning', group: 'Chime', url: chimeWarning }
]

const BY_ID = new Map(SOUND_OPTIONS.map((o) => [o.id, o] as const))

export function soundUrl(id: string): string | null {
  return BY_ID.get(id)?.url ?? null
}
