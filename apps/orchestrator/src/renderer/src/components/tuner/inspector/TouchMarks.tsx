import type { TiCursor } from '@shared/tuner-inspector'
import { isPhoneView } from '../../../lib/tuner/view-mirror'

export function TouchMarks({ cursors, island, dx = 0, dy = 0 }: { cursors: TiCursor[] | undefined; island?: number; dx?: number; dy?: number }) {
  if (!cursors?.length || !isPhoneView()) return null
  return (
    <>
      {cursors.map((c, i) =>
        c.im !== island ? null : (
          <div
            key={`c${i}`}
            data-ti-cursor={c.c}
            style={{ position: 'absolute', left: dx + c.x, top: dy + c.y, width: c.w, height: c.h, pointerEvents: 'none' }}
          />
        )
      )}
    </>
  )
}
