import GoTrueClient from '../../packages/core/auth-js/src/GoTrueClient'
import type { Session } from '../../packages/core/auth-js/src'
import { getItemAsync, setItemAsync } from '../../packages/core/auth-js/src/lib/helpers'
import { memoryLocalStorageAdapter } from '../../packages/core/auth-js/src/lib/local-storage'

const originalSession: Session = {
  access_token: 'access-r1',
  refresh_token: 'refresh-r1',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) - 60,
  user: { id: 'user-1', email: 'user@example.com' } as any,
}

const rotatedSession: Session = {
  ...originalSession,
  access_token: 'access-r2',
  refresh_token: 'refresh-r2',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
}

describe('Fieldwork SSR cookie persistence baseline', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('unpatched source exposes the first cookie-write failure and stops the public refresh', async () => {
    const storage = memoryLocalStorageAdapter()
    const storageKey = `fieldwork-ssr-baseline-${Date.now()}-${Math.random()}`
    const client = new GoTrueClient({
      url: 'http://localhost:9999',
      storage,
      storageKey,
      autoRefreshToken: false,
      persistSession: true,
      skipAutoInitialize: true,
    })
    await client.initialize()
    jest.spyOn(console, 'error').mockImplementation(() => {})

    let finishInitialDelivery: () => void = () => {}
    const initialDelivered = new Promise<void>((resolve) => {
      finishInitialDelivery = resolve
    })
    let cookieWriteAttempts = 0
    client.onAuthStateChange(async (event, session) => {
      if (event === 'INITIAL_SESSION') {
        finishInitialDelivery()
        return
      }
      if (event !== 'TOKEN_REFRESHED' || !session) return
      cookieWriteAttempts += 1
      await Promise.resolve()
      throw new Error('fieldwork SSR setAll failed')
    })
    await initialDelivered
    await setItemAsync(storage, storageKey, originalSession)

    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let releaseRefresh: () => void = () => {}
    const release = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    ;(client as any)._refreshAccessToken = jest.fn(async () => {
      markStarted()
      await release
      return {
        data: { session: rotatedSession, user: rotatedSession.user },
        error: null,
      }
    })

    const responseCookieRefreshToken = originalSession.refresh_token
    const initiating = client.refreshSession()
    await started
    const joining = (client as any)._callRefreshToken(originalSession.refresh_token)
    releaseRefresh()

    await expect(initiating).rejects.toThrow('fieldwork SSR setAll failed')
    await expect(joining).rejects.toThrow('fieldwork SSR setAll failed')

    expect(cookieWriteAttempts).toBe(1)
    expect((client as any)._refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(responseCookieRefreshToken).toBe(originalSession.refresh_token)
    expect(
      ((await getItemAsync(storage, storageKey)) as Session | null)?.refresh_token
    ).toBe(rotatedSession.refresh_token)
    expect((client as any).lastRefreshFailure).toBeNull()

    await client.dispose()
  })
})
