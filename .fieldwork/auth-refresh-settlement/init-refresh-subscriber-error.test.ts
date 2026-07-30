import GoTrueClient from '../../packages/core/auth-js/src/GoTrueClient'
import type { Session } from '../../packages/core/auth-js/src'
import { getItemAsync, setItemAsync } from '../../packages/core/auth-js/src/lib/helpers'
import { memoryLocalStorageAdapter } from '../../packages/core/auth-js/src/lib/local-storage'

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

const settlesWithin = async <T>(promise: Promise<T>, timeoutMs = 2000): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`promise did not settle within ${timeoutMs}ms`)),
          timeoutMs
        )
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

const createInitFixture = async () => {
  const storage = memoryLocalStorageAdapter()
  const storageKey = `fieldwork-init-refresh-${Date.now()}-${Math.random()}`
  const now = Math.floor(Date.now() / 1000)
  const originalSession: Session = {
    access_token: 'access-r1',
    refresh_token: 'refresh-r1',
    token_type: 'bearer',
    expires_in: 30,
    expires_at: now + 30,
    user: { id: 'user-1', email: 'user@example.com' } as any,
  }
  const rotatedSession: Session = {
    ...originalSession,
    access_token: 'access-r2',
    refresh_token: 'refresh-r2',
    expires_in: 3600,
    expires_at: now + 3600,
  }
  await setItemAsync(storage, storageKey, originalSession)

  const client = new GoTrueClient({
    url: 'http://localhost:9999',
    storage,
    storageKey,
    autoRefreshToken: true,
    persistSession: true,
    skipAutoInitialize: true,
  })
  const refreshAccessToken = jest.fn(async () => ({
    data: { session: rotatedSession, user: rotatedSession.user },
    error: null,
  }))
  ;(client as any)._refreshAccessToken = refreshAccessToken

  return { storage, storageKey, originalSession, rotatedSession, client, refreshAccessToken }
}

describe('Fieldwork queued TOKEN_REFRESHED settlement', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('subscriber failure does not reject initialization after commit', async () => {
    const fixture = await createInitFixture()
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)

    fixture.client.onAuthStateChange(async (event) => {
      if (event === 'TOKEN_REFRESHED') {
        throw new Error('queued subscriber failed')
      }
    })

    try {
      await expect(settlesWithin(fixture.client.initialize())).resolves.toBeDefined()
      await nextTurn()

      const stored = (await getItemAsync(
        fixture.storage,
        fixture.storageKey
      )) as Session | null
      expect(stored?.refresh_token).toBe(fixture.rotatedSession.refresh_token)
      expect(fixture.refreshAccessToken).toHaveBeenCalledTimes(1)
      expect(consoleError).toHaveBeenCalled()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await fixture.client.dispose()
    }
  })

  test('default nested refresh receives queued event session without a second rotation', async () => {
    const fixture = await createInitFixture()
    let handled = false
    let nestedSession: Session | null | undefined

    fixture.client.onAuthStateChange(async (event) => {
      if (event !== 'TOKEN_REFRESHED' || handled) return
      handled = true
      const { data, error } = await fixture.client.refreshSession()
      expect(error).toBeNull()
      nestedSession = data.session
    })

    await expect(settlesWithin(fixture.client.initialize())).resolves.toBeDefined()

    expect(nestedSession?.refresh_token).toBe(fixture.rotatedSession.refresh_token)
    expect(fixture.refreshAccessToken).toHaveBeenCalledTimes(1)
    const stored = (await getItemAsync(fixture.storage, fixture.storageKey)) as Session | null
    expect(stored?.refresh_token).toBe(fixture.rotatedSession.refresh_token)

    await fixture.client.dispose()
  })
})
