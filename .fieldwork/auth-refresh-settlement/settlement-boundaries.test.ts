import GoTrueClient from '../../packages/core/auth-js/src/GoTrueClient'
import { AuthError } from '../../packages/core/auth-js/src'
import type { Session } from '../../packages/core/auth-js/src'
import { getItemAsync, setItemAsync } from '../../packages/core/auth-js/src/lib/helpers'
import { memoryLocalStorageAdapter } from '../../packages/core/auth-js/src/lib/local-storage'

const createClient = async (session?: Session, throwOnError = false) => {
  const storage = memoryLocalStorageAdapter()
  const storageKey = `fieldwork-boundaries-${Date.now()}-${Math.random()}`
  if (session) {
    await setItemAsync(storage, storageKey, session)
  }
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
  return { client, storage, storageKey }
}

const settleWithin = async <T>(
  promise: PromiseLike<T>,
  timeoutMs = 100
): Promise<
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; error: unknown }
  | { status: 'timeout' }
> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (error) => ({ status: 'rejected' as const, error })
      ),
      new Promise<{ status: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const session: Session = {
  access_token: 'access-r2',
  refresh_token: 'refresh-r2',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'user-1', email: 'user@example.com' } as any,
}

describe('Fieldwork refresh settlement boundaries', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('non-refresh subscriber failures retain their existing rejection behavior', async () => {
    const { client } = await createClient()
    jest.spyOn(console, 'error').mockImplementation(() => {})

    client.onAuthStateChange(async (event) => {
      if (event === 'SIGNED_IN') {
        throw new Error('signed-in subscriber failed')
      }
    })

    await expect(
      (client as any)._notifyAllSubscribers('SIGNED_IN', session, false)
    ).rejects.toThrow('signed-in subscriber failed')

    await client.dispose()
  })

  test('notification transport failures are not swallowed as subscriber failures', async () => {
    const { client } = await createClient()
    ;(client as any).broadcastChannel = {
      postMessage: () => {
        throw new Error('broadcast transport failed')
      },
    }

    await expect(
      (client as any)._notifyAllSubscribers('TOKEN_REFRESHED', session, true)
    ).rejects.toThrow('broadcast transport failed')

    ;(client as any).broadcastChannel = null
    await client.dispose()
  })

  test('transport failure exposes the selected joined-caller settlement behavior', async () => {
    const originalSession: Session = {
      ...session,
      access_token: 'access-r1',
      refresh_token: 'refresh-r1',
    }
    const rotatedSession: Session = {
      ...session,
      access_token: 'access-r2',
      refresh_token: 'refresh-r2',
    }
    const { client, storage, storageKey } = await createClient(originalSession)
    ;(client as any)._refreshAccessToken = jest.fn(async () => ({
      data: { session: rotatedSession, user: rotatedSession.user },
      error: null,
    }))

    let joinedOutcome: Promise<'success' | 'rejection'> | undefined
    ;(client as any).broadcastChannel = {
      postMessage: () => {
        joinedOutcome = (client as any)
          ._callRefreshToken(originalSession.refresh_token)
          .then(
            () => 'success' as const,
            () => 'rejection' as const
          )
        throw new Error('broadcast transport failed after commit')
      },
    }

    await expect(
      (client as any)._callRefreshToken(originalSession.refresh_token)
    ).rejects.toThrow('broadcast transport failed after commit')

    expect(joinedOutcome).toBeDefined()
    await expect(joinedOutcome).resolves.toBe(process.env.FIELDWORK_TRANSPORT_JOINER_OUTCOME)
    expect(
      ((await getItemAsync(storage, storageKey)) as Session | null)?.refresh_token
    ).toBe(rotatedSession.refresh_token)

    ;(client as any).broadcastChannel = null
    await client.dispose()
  })

  test.each([false, true])(
    'TOKEN_REFRESHED AuthError remains a callback failure after commit (throwOnError=%s)',
    async (throwOnError) => {
      const originalSession: Session = {
        ...session,
        access_token: 'access-r1',
        refresh_token: 'refresh-r1',
        expires_at: Math.floor(Date.now() / 1000) - 60,
      }
      const rotatedSession: Session = {
        ...session,
        access_token: 'access-r2',
        refresh_token: 'refresh-r2',
      }
      const { client, storage, storageKey } = await createClient(originalSession, throwOnError)
      jest.spyOn(console, 'error').mockImplementation(() => {})
      ;(client as any)._refreshAccessToken = jest.fn(async () => ({
        data: { session: rotatedSession, user: rotatedSession.user },
        error: null,
      }))

      client.onAuthStateChange(async (event) => {
        if (event === 'TOKEN_REFRESHED') {
          throw new AuthError('refresh listener auth error')
        }
      })

      await expect(client.refreshSession()).resolves.toMatchObject({
        data: { session: { refresh_token: rotatedSession.refresh_token } },
        error: null,
      })
      expect(
        ((await getItemAsync(storage, storageKey)) as Session | null)?.refresh_token
      ).toBe(rotatedSession.refresh_token)
      expect((client as any).lastRefreshFailure).toBeNull()

      await client.dispose()
    }
  )

  test('SIGNED_OUT subscriber failure can orphan a concurrent refresh joiner', async () => {
    const expiredSession: Session = {
      ...session,
      access_token: 'access-expired',
      refresh_token: 'refresh-expired',
      expires_at: Math.floor(Date.now() / 1000) - 60,
    }
    const { client, storage, storageKey } = await createClient(expiredSession)
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
        data: { session: null, user: null },
        error: new AuthError('refresh token rejected'),
      }
    })

    client.onAuthStateChange(async (event) => {
      if (event === 'SIGNED_OUT') {
        throw new Error('signed-out subscriber failed')
      }
    })

    const initiating = settleWithin(
      (client as any)._callRefreshToken(expiredSession.refresh_token),
      500
    )
    await started
    const joining = settleWithin(
      (client as any)._callRefreshToken(expiredSession.refresh_token),
      100
    )
    releaseRefresh()

    const initiatingOutcome = await initiating
    expect(initiatingOutcome.status).toBe('rejected')
    if (initiatingOutcome.status === 'rejected') {
      expect(initiatingOutcome.error).toEqual(new Error('signed-out subscriber failed'))
    }
    await expect(joining).resolves.toEqual({ status: 'timeout' })
    expect(await getItemAsync(storage, storageKey)).toBeNull()
    expect((client as any).lastRefreshFailure).toBeNull()

    await client.dispose()
  })

  test('cross-tab TOKEN_REFRESHED callback can read the event session without rotating again', async () => {
    const { client } = await createClient(session)
    const refreshAccessToken = jest.fn(async () => ({
      data: { session, user: session.user },
      error: null,
    }))
    ;(client as any)._refreshAccessToken = refreshAccessToken

    let nestedSession: Session | null | undefined
    client.onAuthStateChange(async (event) => {
      if (event !== 'TOKEN_REFRESHED') return
      const { data, error } = await client.refreshSession()
      expect(error).toBeNull()
      nestedSession = data.session
    })

    await (client as any)._notifyAllSubscribers('TOKEN_REFRESHED', session, false)

    expect(nestedSession?.refresh_token).toBe(session.refresh_token)
    expect(refreshAccessToken).not.toHaveBeenCalled()
    await client.dispose()
  })
})