import { useEffect, useRef, useState } from 'react'

export interface AgentFeedbackFrame {
  seq: number
  dataUrl: string
}

const HIDE_MS = 10000

export function useAgentFeedback(projectPath: string, enabled: boolean): AgentFeedbackFrame | null {
  const [frame, setFrame] = useState<AgentFeedbackFrame | null>(null)
  const hideRef = useRef<number | undefined>(undefined)
  const seqRef = useRef(0)

  useEffect(() => {
    if (!enabled) {
      if (hideRef.current) clearTimeout(hideRef.current)
      setFrame(null)
      return
    }
    const off = window.api.unity.onAgentFeedback((e) => {
      if (e.projectPath !== projectPath || e.seq <= seqRef.current) return
      seqRef.current = e.seq
      if (hideRef.current) clearTimeout(hideRef.current)
      setFrame({ seq: e.seq, dataUrl: e.dataUrl })
      hideRef.current = window.setTimeout(() => setFrame(null), HIDE_MS)
    })
    return () => {
      off()
      if (hideRef.current) clearTimeout(hideRef.current)
      setFrame(null)
    }
  }, [projectPath, enabled])

  return frame
}
