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

const createClient = async (throwOnError = false) => {
  const storage = memoryLocalStorageAdapter()
  const storageKey = `fieldwork-ssr-cookie-${Date.now()}-${Math.random()}`
  const client = new GoTrueClient({
    url: 'http://localhost:9999',
    storage,
    storageKey,
    autoRefreshToken: false,
    persistSession: true,
    skipAutoInitialize: true,
    throwOnError,
  })
  await client.initialize()
  await setItemAsync(storage, storageKey, originalSession)
  ;(client as any)._refreshAccessToken = jest.fn(async () => ({
    data: { session: rotatedSession, user: rotatedSession.user },
    error: null,
  }))
  return { client, storage, storageKey }
}

describe('Fieldwork SSR cookie persistence boundary', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test.each([false, true])(
    'current candidate hides a TOKEN_REFRESHED cookie-write failure after commit (throwOnError=%s)',
    async (throwOnError) => {
      const { client, storage, storageKey } = await createClient(throwOnError)
      jest.spyOn(console, 'error').mockImplementation(() => {})

      let responseCookieRefreshToken = originalSession.refresh_token
      let cookieWriteAttempts = 0
      client.onAuthStateChange(async (event, session) => {
        if (event !== 'TOKEN_REFRESHED' || !session) return
        cookieWriteAttempts += 1
        await Promise.resolve()
        throw new Error('fieldwork SSR setAll failed')
      })

      await expect(client.refreshSession()).resolves.toMatchObject({
        data: { session: { refresh_token: rotatedSession.refresh_token } },
        error: null,
      })

      expect(cookieWriteAttempts).toBe(1)
      expect(responseCookieRefreshToken).toBe(originalSession.refresh_token)
      expect(
        ((await getItemAsync(storage, storageKey)) as Session | null)?.refresh_token
      ).toBe(rotatedSession.refresh_token)
      expect((client as any).lastRefreshFailure).toBeNull()

      await client.dispose()
    }
  )

  test('current candidate gives every joined refresh caller success while the response cookie stays stale', async () => {
    const { client, storage, storageKey } = await createClient()
    jest.spyOn(console, 'error').mockImplementation(() => {})

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

    let responseCookieRefreshToken = originalSession.refresh_token
    client.onAuthStateChange(async (event, session) => {
      if (event !== 'TOKEN_REFRESHED' || !session) return
      await Promise.resolve()
      throw new Error('fieldwork SSR setAll failed')
    })

    const initiating = (client as any)._callRefreshToken(originalSession.refresh_token)
    await started
    const joining = (client as any)._callRefreshToken(originalSession.refresh_token)
    releaseRefresh()

    await expect(initiating).resolves.toMatchObject({
      data: { refresh_token: rotatedSession.refresh_token },
      error: null,
    })
    await expect(joining).resolves.toMatchObject({
      data: { refresh_token: rotatedSession.refresh_token },
      error: null,
    })

    expect(responseCookieRefreshToken).toBe(originalSession.refresh_token)
    expect(
      ((await getItemAsync(storage, storageKey)) as Session | null)?.refresh_token
    ).toBe(rotatedSession.refresh_token)
    expect((client as any)._refreshAccessToken).toHaveBeenCalledTimes(1)
    expect((client as any).lastRefreshFailure).toBeNull()

    await client.dispose()
  })
})
