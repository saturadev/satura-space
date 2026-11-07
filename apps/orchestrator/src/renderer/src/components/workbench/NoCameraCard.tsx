export function NoCameraCard({ remote = false }: { remote?: boolean }) {
  return (
    <div className={`flex flex-col items-center gap-2 text-center ${remote ? 'max-w-[300px]' : 'max-w-sm px-6'}`} data-unity-no-camera-card>
      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400" />
      <p className={remote ? 'text-[15px] font-medium text-zinc-100' : 'text-sm text-zinc-200'}>No camera renders the game view</p>
      <p className={`leading-snug text-zinc-400 ${remote ? 'text-[13px]' : 'text-xs'}`}>
        The game is in Play Mode, but nothing draws to Display 1. If a script creates the camera when the scene starts, it probably failed: the Console shows the error.
      </p>
    </div>
  )
}
