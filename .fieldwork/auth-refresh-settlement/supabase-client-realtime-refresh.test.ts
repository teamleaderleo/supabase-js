import SupabaseClient from '../../packages/core/supabase-js/src/SupabaseClient'
import type { Session } from '../../packages/core/auth-js/src'
import { setItemAsync } from '../../packages/core/auth-js/src/lib/helpers'
import { memoryLocalStorageAdapter } from '../../packages/core/auth-js/src/lib/local-storage'

const baseSession: Session = {
  access_token: 'access-r1',
  refresh_token: 'refresh-r1',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) - 60,
  user: { id: 'user-1', email: 'user@example.com' } as any,
}

describe('Fieldwork SupabaseClient Realtime refresh handoff', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('hands the rotated token to Realtime before refresh returns without awaiting Realtime completion', async () => {
    const storage = memoryLocalStorageAdapter()
    const storageKey = `fieldwork-wrapper-${Date.now()}-${Math.random()}`
    const client = new SupabaseClient('http://localhost:54321', 'anon-key', {
      auth: {
        storage,
        storageKey,
        autoRefreshToken: false,
        persistSession: true,
        detectSessionInUrl: false,
        skipAutoInitialize: true,
      },
    })
    await client.auth.initialize()
    await setItemAsync(storage, storageKey, baseSession)

    const rotatedSession: Session = {
      ...baseSession,
      access_token: 'access-r2',
      refresh_token: 'refresh-r2',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }
    ;(client.auth as any)._refreshAccessToken = jest.fn(async () => ({
      data: { session: rotatedSession, user: rotatedSession.user },
      error: null,
    }))

    let releaseRealtimeAuth: () => void = () => {}
    const realtimeAuthRelease = new Promise<void>((resolve) => {
      releaseRealtimeAuth = resolve
    })
    let realtimeAuthCompleted = false
    let realtimeAuthPromise: Promise<void> | undefined
    const setAuth = jest.spyOn(client.realtime, 'setAuth').mockImplementation(async (token) => {
      expect(token).toBe(rotatedSession.access_token)
      realtimeAuthPromise = realtimeAuthRelease.then(() => {
        realtimeAuthCompleted = true
      })
      await realtimeAuthPromise
    })

    await expect(client.auth.refreshSession()).resolves.toMatchObject({
      data: { session: { refresh_token: rotatedSession.refresh_token } },
      error: null,
    })

    expect(setAuth).toHaveBeenCalledTimes(1)
    expect(setAuth).toHaveBeenCalledWith(rotatedSession.access_token)
    expect(realtimeAuthCompleted).toBe(false)

    releaseRealtimeAuth()
    await realtimeAuthPromise
    expect(realtimeAuthCompleted).toBe(true)

    await client.auth.dispose()
  })
})
