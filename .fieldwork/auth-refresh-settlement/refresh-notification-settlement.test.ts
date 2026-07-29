import GoTrueClient from '../../packages/core/auth-js/src/GoTrueClient'
import type { Session } from '../../packages/core/auth-js/src'
import { getItemAsync, setItemAsync } from '../../packages/core/auth-js/src/lib/helpers'
import { memoryLocalStorageAdapter } from '../../packages/core/auth-js/src/lib/local-storage'

type Fixture = Awaited<ReturnType<typeof createFixture>>

const AUTH_URL = 'http://localhost:9999'

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

const settlesWithin = <T>(promise: Promise<T>, timeoutMs = 2000): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`promise did not settle within ${timeoutMs}ms`)), timeoutMs)
    ),
  ])

const createFixture = async () => {
  const storage = memoryLocalStorageAdapter()
  const storageKey = `fieldwork-refresh-settlement-${Date.now()}-${Math.random()}`
  const now = Math.floor(Date.now() / 1000)

  const originalSession: Session = {
    access_token: 'access-r1',
    refresh_token: 'refresh-r1',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: now + 3600,
    user: { id: 'user-1', email: 'user@example.com' } as any,
  }

  const rotatedSession: Session = {
    ...originalSession,
    access_token: 'access-r2',
    refresh_token: 'refresh-r2',
    expires_at: now + 7200,
  }

  await setItemAsync(storage, storageKey, originalSession)

  const client = new GoTrueClient({
    url: AUTH_URL,
    storage,
    storageKey,
    autoRefreshToken: false,
    persistSession: true,
    skipAutoInitialize: true,
  })
  await client.initialize()

  const refreshAccessToken = jest.fn(async () => ({
    data: { session: rotatedSession, user: rotatedSession.user },
    error: null,
  }))
  ;(client as any)._refreshAccessToken = refreshAccessToken

  const callRefresh = (refreshToken: string) =>
    (client as any)._callRefreshToken(refreshToken) as Promise<{
      data: Session | null
      error: unknown
    }>

  return {
    client,
    storage,
    storageKey,
    originalSession,
    rotatedSession,
    refreshAccessToken,
    callRefresh,
  }
}

const storedSession = async (fixture: Fixture) =>
  (await getItemAsync(fixture.storage, fixture.storageKey)) as Session | null

describe('Fieldwork auth refresh notification settlement', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('nested refreshSession receives the committed session without a second token request', async () => {
    const fixture = await createFixture()
    let nestedSession: Session | null | undefined

    fixture.client.onAuthStateChange(async (event) => {
      if (event !== 'TOKEN_REFRESHED') return
      const { data, error } = await fixture.client.refreshSession()
      expect(error).toBeNull()
      nestedSession = data.session
    })

    const result = await settlesWithin(
      fixture.callRefresh(fixture.originalSession.refresh_token)
    )

    expect(result.error).toBeNull()
    expect(result.data?.refresh_token).toBe(fixture.rotatedSession.refresh_token)
    expect(nestedSession?.refresh_token).toBe(fixture.rotatedSession.refresh_token)
    expect(fixture.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect((await storedSession(fixture))?.refresh_token).toBe(
      fixture.rotatedSession.refresh_token
    )

    await fixture.client.dispose()
  })

  test('throwing subscriber is reported without overturning a committed refresh', async () => {
    const fixture = await createFixture()
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)

    const visited: string[] = []
    fixture.client.onAuthStateChange(async (event) => {
      if (event !== 'TOKEN_REFRESHED') return
      visited.push('throwing')
      throw new Error('application subscriber failed')
    })
    fixture.client.onAuthStateChange(async (event) => {
      if (event !== 'TOKEN_REFRESHED') return
      visited.push('healthy')
    })

    try {
      const result = await settlesWithin(
        fixture.callRefresh(fixture.originalSession.refresh_token)
      )
      await nextTurn()

      expect(result.error).toBeNull()
      expect(result.data?.refresh_token).toBe(fixture.rotatedSession.refresh_token)
      expect(visited).toEqual(expect.arrayContaining(['throwing', 'healthy']))
      expect(consoleError).toHaveBeenCalled()
      expect(unhandled).toEqual([])
      expect((await storedSession(fixture))?.refresh_token).toBe(
        fixture.rotatedSession.refresh_token
      )
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await fixture.client.dispose()
    }
  })

  test('initiating refresh waits for SSR-like async subscriber work', async () => {
    const fixture = await createFixture()
    const callbackStarted = deferred()
    const releaseCallback = deferred()
    let cookieFlushFinished = false

    fixture.client.onAuthStateChange(async (event) => {
      if (event !== 'TOKEN_REFRESHED') return
      callbackStarted.resolve()
      await releaseCallback.promise
      cookieFlushFinished = true
    })

    let outerSettled = false
    const outer = fixture
      .callRefresh(fixture.originalSession.refresh_token)
      .then((result) => {
        outerSettled = true
        return result
      })

    await callbackStarted.promise
    await nextTurn()
    expect(outerSettled).toBe(false)
    expect(cookieFlushFinished).toBe(false)

    releaseCallback.resolve()
    const result = await settlesWithin(outer)

    expect(result.error).toBeNull()
    expect(cookieFlushFinished).toBe(true)
    await fixture.client.dispose()
  })

  test('old-token joiner timing matches the selected experiment', async () => {
    const fixture = await createFixture()
    const callbackStarted = deferred()
    const releaseCallback = deferred()

    fixture.client.onAuthStateChange(async (event) => {
      if (event !== 'TOKEN_REFRESHED') return
      callbackStarted.resolve()
      await releaseCallback.promise
    })

    const outer = fixture.callRefresh(fixture.originalSession.refresh_token)
    await callbackStarted.promise

    let joinerSettled = false
    const joiner = fixture
      .callRefresh(fixture.originalSession.refresh_token)
      .then((result) => {
        joinerSettled = true
        return result
      })

    await nextTurn()
    expect(joinerSettled).toBe(process.env.FIELDWORK_OLD_TOKEN_JOINER_EARLY === 'true')

    releaseCallback.resolve()
    const [outerResult, joinerResult] = await Promise.all([
      settlesWithin(outer),
      settlesWithin(joiner),
    ])

    expect(outerResult.error).toBeNull()
    expect(joinerResult.error).toBeNull()
    expect(fixture.refreshAccessToken).toHaveBeenCalledTimes(1)
    await fixture.client.dispose()
  })

  test('explicit old-token nested refresh exposes completeness difference', async () => {
    const fixture = await createFixture()
    let nestedOutcome: 'success' | 'timeout' | undefined

    fixture.client.onAuthStateChange(async (event) => {
      if (event !== 'TOKEN_REFRESHED') return

      nestedOutcome = await Promise.race([
        fixture.client
          .refreshSession({ refresh_token: fixture.originalSession.refresh_token })
          .then(({ error }): 'success' | 'timeout' => (error ? 'timeout' : 'success')),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
      ])
    })

    const result = await settlesWithin(
      fixture.callRefresh(fixture.originalSession.refresh_token)
    )

    expect(result.error).toBeNull()
    expect(nestedOutcome).toBe(process.env.FIELDWORK_EXPLICIT_OLD_TOKEN_NESTED)
    expect(fixture.refreshAccessToken).toHaveBeenCalledTimes(1)
    await fixture.client.dispose()
  })
})
