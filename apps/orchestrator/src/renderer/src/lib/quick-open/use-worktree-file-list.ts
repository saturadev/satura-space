import { useEffect, useState } from 'react'

export function useWorktreeFileList(rootPath: string): {
  files: string[]
  loading: boolean
  error: boolean
} {
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(false)
    window.api.fs
      .listFiles(rootPath)
      .then((f) => {
        if (!alive) return
        setFiles(f)
        setLoading(false)
      })
      .catch(() => {
        if (!alive) return
        setError(true)
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [rootPath])

  return { files, loading, error }
}
