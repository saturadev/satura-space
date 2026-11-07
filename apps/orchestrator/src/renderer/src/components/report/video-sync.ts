import { createContext } from 'react'

export const VideoSyncContext = createContext<{ height: number } | null>(null)
