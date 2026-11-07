import type { StateCreator } from 'zustand'
import type { AppState } from '../index'
import type { AuthUser } from '@shared/api'

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

export interface AuthSlice {
  authConfigured: boolean
  authStatus: AuthStatus
  authUser: AuthUser | null
  signInUrl: string | null
  signingIn: boolean

  checkSession: () => Promise<void>
  startSignIn: (open?: boolean) => Promise<void>
  signOut: () => Promise<void>
  bindAuthEvents: () => () => void
}

export const createAuthSlice: StateCreator<AppState, [], [], AuthSlice> = (set) => ({
  authConfigured: false,
  authStatus: 'loading',
  authUser: null,
  signInUrl: null,
  signingIn: false,

  checkSession: async () => {
    const [configured, user] = await Promise.all([window.api.auth.configured(), window.api.auth.getSession()])
    set({ authConfigured: configured, authUser: user, authStatus: user ? 'authenticated' : 'unauthenticated' })
  },

  startSignIn: async (open = true) => {
    set({ signingIn: true })
    try {
      const { url } = await window.api.auth.startSignIn(open)
      set({ signInUrl: url })
    } finally {
      set({ signingIn: false })
    }
  },

  signOut: async () => {
    await window.api.auth.signOut()
    set({ authUser: null, authStatus: 'unauthenticated', signInUrl: null })
  },

  bindAuthEvents: () => {
    const offIn = window.api.auth.onSignedIn((user) => {
      set({ authUser: user, authStatus: 'authenticated', signInUrl: null })
    })
    const offOut = window.api.auth.onSignedOut(() => {
      set({ authUser: null, authStatus: 'unauthenticated', signInUrl: null })
    })
    return () => {
      offIn()
      offOut()
    }
  },
})
