import { useAgentFeedback } from '../../lib/unity/agent-feedback'

export function AgentFeedbackOverlay({ projectPath }: { projectPath: string }) {
  const frame = useAgentFeedback(projectPath, true)
  if (!frame) return null
  return (
    <div
      key={frame.seq}
      className="agent-feedback-in pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/40"
    >
      <img src={frame.dataUrl} className="max-h-full max-w-full object-contain" />
    </div>
  )
}
