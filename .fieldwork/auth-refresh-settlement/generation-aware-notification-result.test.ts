import GoTrueClient from '../../packages/core/auth-js/src/GoTrueClient'
import type { Session } from '../../packages/core/auth-js/src'
import { memoryLocalStorageAdapter } from '../../packages/core/auth-js/src/lib/local-storage'

const refreshToken = 'refresh-r2'

const sessionA2: Session = {
  access_token: 'access-a2',
  refresh_token: refreshToken,
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'user-1', email: 'user@example.com' } as any,
}

const sessionA3: Session = {
  ...sessionA2,
  access_token: 'access-a3',
  expires_at: sessionA2.expires_at! + 60,
}

const deferred = () => {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function createClient(storage = memoryLocalStorageAdapter()) {
  const client = new GoTrueClient({
    url: 'http://localhost:9999',
    storage,
    storageKey: `fieldwork-generation-owner-${Date.now()}-${Math.random()}`,
    autoRefreshToken: false,
    persistSession: true,
    skipAutoInitialize: true,
  })
  await client.initialize()
  return client
}

function installBlockingNotifications(client: GoTrueClient) {
  const starts = new Map<string, ReturnType<typeof deferred>>()
  const releases = new Map<string, ReturnType<typeof deferred>>()

  client.onAuthStateChange(async (event, session) => {
    if (event !== 'TOKEN_REFRESHED' || !session) return
    let start = starts.get(session.access_token)
    if (!start) {
      start = deferred()
      starts.set(session.access_token, start)
    }
    let release = releases.get(session.access_token)
    if (!release) {
      release = deferred()
      releases.set(session.access_token, release)
    }
    start.resolve()
    await release.promise
  })

  return {
    started(accessToken: string) {
      let start = starts.get(accessToken)
      if (!start) {
        start = deferred()
        starts.set(accessToken, start)
      }
      return start.promise
    },
    release(accessToken: string) {
      releases.get(accessToken)?.resolve()
    },
  }
}

describe('Fieldwork generation-aware notification ownership', () => {
  test('same refresh token resolves through the authoritative stored access-token generation', async () => {
    const client = await createClient()
    const notifications = installBlockingNotifications(client)
    const refreshAccessToken = jest.fn(async () => {
      throw new Error('no authoritative active notification result')
    })
    ;(client as any)._refreshAccessToken = refreshAccessToken

    await (client as any)._saveSession(sessionA2)
    const notifyA2 = (client as any)._notifyAllSubscribers(
      'TOKEN_REFRESHED',
      sessionA2,
      false
    )
    await notifications.started(sessionA2.access_token)

    await expect((client as any)._callRefreshToken(refreshToken)).resolves.toMatchObject({
      data: { access_token: sessionA2.access_token },
      error: null,
    })

    await (client as any)._saveSession(sessionA3)
    const notifyA3 = (client as any)._notifyAllSubscribers(
      'TOKEN_REFRESHED',
      sessionA3,
      false
    )
    await notifications.started(sessionA3.access_token)

    const generations = (client as any).notifyingRefreshResults.get(refreshToken)
    expect(generations.size).toBe(2)
    await expect((client as any)._callRefreshToken(refreshToken)).resolves.toMatchObject({
      data: { access_token: sessionA3.access_token },
      error: null,
    })

    notifications.release(sessionA2.access_token)
    await notifyA2
    expect(generations.has(sessionA2.access_token)).toBe(false)
    expect(generations.has(sessionA3.access_token)).toBe(true)
    await expect((client as any)._callRefreshToken(refreshToken)).resolves.toMatchObject({
      data: { access_token: sessionA3.access_token },
      error: null,
    })

    notifications.release(sessionA3.access_token)
    await notifyA3
    expect((client as any).notifyingRefreshResults.size).toBe(0)
    await expect((client as any)._callRefreshToken(refreshToken)).rejects.toThrow(
      'no authoritative active notification result'
    )
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    await client.dispose()
  })

  test('does not fall back to an older active generation after the authoritative generation finishes', async () => {
    const client = await createClient()
    const notifications = installBlockingNotifications(client)
    const refreshAccessToken = jest.fn(async () => {
      throw new Error('ordinary refresh required')
    })
    ;(client as any)._refreshAccessToken = refreshAccessToken

    await (client as any)._saveSession(sessionA2)
    const notifyA2 = (client as any)._notifyAllSubscribers(
      'TOKEN_REFRESHED',
      sessionA2,
      false
    )
    await notifications.started(sessionA2.access_token)

    await (client as any)._saveSession(sessionA3)
    const notifyA3 = (client as any)._notifyAllSubscribers(
      'TOKEN_REFRESHED',
      sessionA3,
      false
    )
    await notifications.started(sessionA3.access_token)

    notifications.release(sessionA3.access_token)
    await notifyA3

    await expect((client as any)._callRefreshToken(refreshToken)).rejects.toThrow(
      'ordinary refresh required'
    )
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)

    notifications.release(sessionA2.access_token)
    await notifyA2
    await client.dispose()
  })

  test('reference-counts identical notification generations independently', async () => {
    const client = await createClient()
    const releases = [deferred(), deferred()]
    const starts = [deferred(), deferred()]
    let callbackIndex = 0

    client.onAuthStateChange(async (event, session) => {
      if (event !== 'TOKEN_REFRESHED' || session?.access_token !== sessionA2.access_token) return
      const index = callbackIndex++
      starts[index].resolve()
      await releases[index].promise
    })

    await (client as any)._saveSession(sessionA2)
    const first = (client as any)._notifyAllSubscribers('TOKEN_REFRESHED', sessionA2, false)
    await starts[0].promise
    const second = (client as any)._notifyAllSubscribers('TOKEN_REFRESHED', sessionA2, false)
    await starts[1].promise

    const generations = (client as any).notifyingRefreshResults.get(refreshToken)
    expect(generations.get(sessionA2.access_token).count).toBe(2)

    releases[0].resolve()
    await first
    expect(generations.get(sessionA2.access_token).count).toBe(1)

    releases[1].resolve()
    await second
    expect((client as any).notifyingRefreshResults.size).toBe(0)
    await client.dispose()
  })

  test('session removal epoch fences old bytes before storage deletion settles', async () => {
    const storageKey = `fieldwork-removal-epoch-${Date.now()}-${Math.random()}`
    const storage = memoryLocalStorageAdapter()
    const originalRemoveItem = storage.removeItem.bind(storage)
    const removalStarted = deferred()
    const finishRemoval = deferred()
    let blocked = true
    storage.removeItem = async (key: string) => {
      if (key === storageKey && blocked) {
        blocked = false
        removalStarted.resolve()
        await finishRemoval.promise
      }
      originalRemoveItem(key)
    }
    const client = new GoTrueClient({
      url: 'http://localhost:9999',
      storage,
      storageKey,
      autoRefreshToken: false,
      persistSession: true,
      skipAutoInitialize: true,
    })
    await client.initialize()
    const notifications = installBlockingNotifications(client)
    const refreshAccessToken = jest.fn(async () => {
      throw new Error('removal fenced notification state')
    })
    ;(client as any)._refreshAccessToken = refreshAccessToken

    await (client as any)._saveSession(sessionA2)
    const notification = (client as any)._notifyAllSubscribers(
      'TOKEN_REFRESHED',
      sessionA2,
      false
    )
    await notifications.started(sessionA2.access_token)

    const removal = (client as any)._removeSession()
    await removalStarted.promise

    await expect((client as any)._callRefreshToken(refreshToken)).rejects.toThrow(
      'removal fenced notification state'
    )
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)

    finishRemoval.resolve()
    await removal
    notifications.release(sessionA2.access_token)
    await notification
    await client.dispose()
  })

  test('storage read failure is not masked by active notification state', async () => {
    const storage = memoryLocalStorageAdapter()
    const client = await createClient(storage)
    const notifications = installBlockingNotifications(client)

    await (client as any)._saveSession(sessionA2)
    const notification = (client as any)._notifyAllSubscribers(
      'TOKEN_REFRESHED',
      sessionA2,
      false
    )
    await notifications.started(sessionA2.access_token)

    const storageError = new Error('storage unavailable')
    storage.getItem = () => {
      throw storageError
    }

    await expect((client as any)._callRefreshToken(refreshToken)).rejects.toBe(storageError)

    notifications.release(sessionA2.access_token)
    await notification
    await client.dispose()
  })
})
