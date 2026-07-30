import GoTrueClient from '../../packages/core/auth-js/src/GoTrueClient'
import { AuthError } from '../../packages/core/auth-js/src'
import type { Session } from '../../packages/core/auth-js/src'
import { getItemAsync, setItemAsync } from '../../packages/core/auth-js/src/lib/helpers'
import { memoryLocalStorageAdapter } from '../../packages/core/auth-js/src/lib/local-storage'

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

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
  const storageKey = `fieldwork-notification-separation-${Date.now()}-${Math.random()}`
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
  return { client, storage, storageKey }
}

const storedRefreshToken = async (
  storage: ReturnType<typeof memoryLocalStorageAdapter>,
  storageKey: string
) => ((await getItemAsync(storage, storageKey)) as Session | null)?.refresh_token

describe('Fieldwork committed refresh notification failure separation', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('nested rotated-token refresh succeeds while initiator and old-token joiner receive the callback failure', async () => {
    const { client, storage, storageKey } = await createClient()
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)

    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let releaseRefresh: () => void = () => {}
    const release = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const refreshAccessToken = jest.fn(async () => {
      markStarted()
      await release
      return {
        data: { session: rotatedSession, user: rotatedSession.user },
        error: null,
      }
    })
    ;(client as any)._refreshAccessToken = refreshAccessToken

    const visited: string[] = []
    let nestedSession: Session | null | undefined
    client.onAuthStateChange(async (event) => {
      if (event !== 'TOKEN_REFRESHED') return
      visited.push('nested')
      const { data, error } = await client.refreshSession()
      expect(error).toBeNull()
      nestedSession = data.session
    })
    client.onAuthStateChange(async (event) => {
      if (event !== 'TOKEN_REFRESHED') return
      visited.push('throwing')
      throw new Error('fieldwork notification failed after commit')
    })
    client.onAuthStateChange(async (event) => {
      if (event !== 'TOKEN_REFRESHED') return
      visited.push('healthy')
    })

    try {
      const initiating = (client as any)._callRefreshToken(originalSession.refresh_token)
      await started
      const joining = (client as any)._callRefreshToken(originalSession.refresh_token)
      releaseRefresh()

      await expect(initiating).rejects.toThrow('fieldwork notification failed after commit')
      await expect(joining).rejects.toThrow('fieldwork notification failed after commit')
      await nextTurn()

      expect(nestedSession?.refresh_token).toBe(rotatedSession.refresh_token)
      expect(visited).toEqual(expect.arrayContaining(['nested', 'throwing', 'healthy']))
      expect(refreshAccessToken).toHaveBeenCalledTimes(1)
      expect(await storedRefreshToken(storage, storageKey)).toBe(rotatedSession.refresh_token)
      expect((client as any).lastRefreshFailure).toBeNull()
      expect(consoleError).toHaveBeenCalled()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await client.dispose()
    }
  })

  test.each([false, true])(
    'AuthError callback stays visible without deleting committed storage (throwOnError=%s)',
    async (throwOnError) => {
      const { client, storage, storageKey } = await createClient(throwOnError)
      jest.spyOn(console, 'error').mockImplementation(() => {})
      const refreshAccessToken = jest.fn(async () => ({
        data: { session: rotatedSession, user: rotatedSession.user },
        error: null,
      }))
      ;(client as any)._refreshAccessToken = refreshAccessToken

      let callbackCalls = 0
      client.onAuthStateChange(async (event) => {
        if (event !== 'TOKEN_REFRESHED') return
        callbackCalls += 1
        throw new AuthError('fieldwork callback auth error')
      })

      if (throwOnError) {
        await expect(client.refreshSession()).rejects.toThrow('fieldwork callback auth error')
      } else {
        await expect(client.refreshSession()).resolves.toMatchObject({
          data: { session: null, user: null },
          error: { message: 'fieldwork callback auth error' },
        })
      }

      expect(callbackCalls).toBe(1)
      expect(refreshAccessToken).toHaveBeenCalledTimes(1)
      expect(await storedRefreshToken(storage, storageKey)).toBe(rotatedSession.refresh_token)
      expect((client as any).lastRefreshFailure).toBeNull()
      await client.dispose()
    }
  )

  test('SSR-style cookie persistence failure stays visible and stops the public refresh after one token request', async () => {
    const { client, storage, storageKey } = await createClient()
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const refreshAccessToken = jest.fn(async () => ({
      data: { session: rotatedSession, user: rotatedSession.user },
      error: null,
    }))
    ;(client as any)._refreshAccessToken = refreshAccessToken

    const responseCookieRefreshToken = originalSession.refresh_token
    let cookieWriteAttempts = 0
    client.onAuthStateChange(async (event, session) => {
      if (event !== 'TOKEN_REFRESHED' || !session) return
      cookieWriteAttempts += 1
      await Promise.resolve()
      throw new Error('fieldwork SSR setAll failed')
    })

    await expect(client.refreshSession()).rejects.toThrow('fieldwork SSR setAll failed')

    expect(cookieWriteAttempts).toBe(1)
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(responseCookieRefreshToken).toBe(originalSession.refresh_token)
    expect(await storedRefreshToken(storage, storageKey)).toBe(rotatedSession.refresh_token)
    expect((client as any).lastRefreshFailure).toBeNull()
    await client.dispose()
  })

  test('notification transport failure rejects every ordinary caller after commit', async () => {
    const { client, storage, storageKey } = await createClient()

    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let releaseRefresh: () => void = () => {}
    const release = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const refreshAccessToken = jest.fn(async () => {
      markStarted()
      await release
      return {
        data: { session: rotatedSession, user: rotatedSession.user },
        error: null,
      }
    })
    ;(client as any)._refreshAccessToken = refreshAccessToken
    ;(client as any).broadcastChannel = {
      postMessage: () => {
        throw new Error('fieldwork broadcast failed after commit')
      },
    }

    const initiating = (client as any)._callRefreshToken(originalSession.refresh_token)
    await started
    const joining = (client as any)._callRefreshToken(originalSession.refresh_token)
    releaseRefresh()

    await expect(initiating).rejects.toThrow('fieldwork broadcast failed after commit')
    await expect(joining).rejects.toThrow('fieldwork broadcast failed after commit')
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(await storedRefreshToken(storage, storageKey)).toBe(rotatedSession.refresh_token)
    expect((client as any).lastRefreshFailure).toBeNull()

    ;(client as any).broadcastChannel = null
    await client.dispose()
  })

  test('successful notification remains awaited by initiator and old-token joiner', async () => {
    const { client } = await createClient()
    const refreshAccessToken = jest.fn(async () => ({
      data: { session: rotatedSession, user: rotatedSession.user },
      error: null,
    }))
    ;(client as any)._refreshAccessToken = refreshAccessToken

    let markCallbackStarted: () => void = () => {}
    const callbackStarted = new Promise<void>((resolve) => {
      markCallbackStarted = resolve
    })
    let releaseCallback: () => void = () => {}
    const callbackRelease = new Promise<void>((resolve) => {
      releaseCallback = resolve
    })
    client.onAuthStateChange(async (event) => {
      if (event !== 'TOKEN_REFRESHED') return
      markCallbackStarted()
      await callbackRelease
    })

    let initiatingSettled = false
    const initiating = (client as any)
      ._callRefreshToken(originalSession.refresh_token)
      .then((result: unknown) => {
        initiatingSettled = true
        return result
      })
    await callbackStarted

    let joiningSettled = false
    const joining = (client as any)
      ._callRefreshToken(originalSession.refresh_token)
      .then((result: unknown) => {
        joiningSettled = true
        return result
      })
    await nextTurn()

    expect(initiatingSettled).toBe(false)
    expect(joiningSettled).toBe(false)
    releaseCallback()

    await expect(initiating).resolves.toMatchObject({
      data: { refresh_token: rotatedSession.refresh_token },
      error: null,
    })
    await expect(joining).resolves.toMatchObject({
      data: { refresh_token: rotatedSession.refresh_token },
      error: null,
    })
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    await client.dispose()
  })

  test('non-refresh callback failure remains a direct notification failure', async () => {
    const { client } = await createClient()
    jest.spyOn(console, 'error').mockImplementation(() => {})
    client.onAuthStateChange(async (event) => {
      if (event === 'SIGNED_IN') {
        throw new Error('fieldwork signed-in callback failed')
      }
    })

    await expect(
      (client as any)._notifyAllSubscribers('SIGNED_IN', rotatedSession, false)
    ).rejects.toThrow('fieldwork signed-in callback failed')
    await client.dispose()
  })
})
