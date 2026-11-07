import type { InputGateProblem } from '@shared/api'
import { openFileInWorkbench } from '../../lib/editor/open-file'
import { debugLog } from '@shared/debug-log'

const BUTTON =
  'flex items-center gap-1.5 rounded border border-white/10 px-3 py-1.5 text-xs text-zinc-300 outline-none transition-colors hover:bg-white/10 hover:text-white'

function handlerText(handler: number): string | null {
  if (handler === 0) return 'Active Input Handling is set to Input Manager (Old).'
  if (handler === 2) return 'Active Input Handling is set to Both.'
  if (handler !== 1) return `Active Input Handling has an unknown value (${handler}).`
  return null
}

export function UnityInputGateView({
  problem,
  projectPath,
  onRetry
}: {
  problem: InputGateProblem
  projectPath: string
  onRetry: () => void
}) {
  const found = [
    handlerText(problem.handler),
    problem.packageMissing ? "The Input System package (com.unity.inputsystem) isn't installed." : null
  ].filter((s): s is string => !!s)
  const switched = problem.handler === 1
  const open = (file: string, line?: number): void => {
    const opened = openFileInWorkbench({ file, line, projectPath, text: true, highlight: true })
    debugLog(`[unity] input gate: open ${file}${line ? `:${line}` : ''} opened=${opened}`)
  }
  return (
    <div
      data-unity-input-gate
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-y-auto bg-canvas py-6 text-center"
    >
      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400" />
      <p className="text-sm text-zinc-200">{switched ? 'Install the Input System package' : 'Switch this project to the Input System'}</p>
      <div className="max-w-md space-y-2 px-6 text-xs leading-snug">
        {found.map((line) => (
          <p key={line} className="text-amber-200/90">
            {line}
          </p>
        ))}
        <p className="text-zinc-400">
          {switched
            ? 'Satura Space works only with the Input System, and Unity stays off here until the project has its package.'
            : 'Satura Space works only with the Input System. The old Input Manager reads input straight from the OS, so keys and clicks in this panel never reach it, and Both has the same problem. Unity stays off here until you switch the project.'}
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-left text-zinc-400">
          {!switched && (
            <li>
              In Unity: Edit › Project Settings › Player › Other Settings › Active Input Handling ›{' '}
              <span className="text-zinc-200">Input System Package (New)</span>.
            </li>
          )}
          {problem.packageMissing && (
            <li>{switched ? 'In Unity: install' : 'Install'} Input System from Window › Package Manager.</li>
          )}
          <li>
            Or edit the files here:{' '}
            {!switched && (
              <>
                set <span className="font-mono text-zinc-200">activeInputHandler: 1</span>
                {problem.packageMissing ? ' and ' : ''}
              </>
            )}
            {problem.packageMissing && (
              <>
                add <span className="font-mono text-zinc-200">com.unity.inputsystem</span> to the manifest
              </>
            )}
            , then press Retry.
          </li>
        </ol>
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-2 px-6">
        {!switched && (
          <button onClick={() => open(problem.settingsFile, problem.settingsLine)} className={BUTTON}>
            Open ProjectSettings.asset
          </button>
        )}
        {problem.packageMissing && (
          <button onClick={() => open(problem.manifestFile)} className={BUTTON}>
            Open manifest.json
          </button>
        )}
        <button onClick={onRetry} className={BUTTON}>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 4v6h-6" />
            <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
          </svg>
          Retry
        </button>
      </div>
    </div>
  )
}
