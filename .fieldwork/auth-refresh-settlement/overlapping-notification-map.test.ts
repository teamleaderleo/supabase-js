import GoTrueClient from '../../packages/core/auth-js/src/GoTrueClient'
import type { Session } from '../../packages/core/auth-js/src'
import { memoryLocalStorageAdapter } from '../../packages/core/auth-js/src/lib/local-storage'

const sessionR2: Session = {
  access_token: 'access-r2',
  refresh_token: 'refresh-r2',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'user-1', email: 'user@example.com' } as any,
}

const sessionR3: Session = {
  ...sessionR2,
  access_token: 'access-r3',
  refresh_token: 'refresh-r3',
}

describe('Fieldwork overlapping notification result map', () => {
  test('out-of-order completion retains only active tokens and leaves no stale result', async () => {
    const client = new GoTrueClient({
      url: 'http://localhost:9999',
      storage: memoryLocalStorageAdapter(),
      storageKey: `fieldwork-overlap-map-${Date.now()}-${Math.random()}`,
      autoRefreshToken: false,
      persistSession: true,
      skipAutoInitialize: true,
    })
    await client.initialize()

    let markInitialDelivered: () => void = () => {}
    const initialDelivered = new Promise<void>((resolve) => {
      markInitialDelivered = resolve
    })
    let markR2Started: () => void = () => {}
    const r2Started = new Promise<void>((resolve) => {
      markR2Started = resolve
    })
    let markR3Started: () => void = () => {}
    const r3Started = new Promise<void>((resolve) => {
      markR3Started = resolve
    })
    let releaseR2: () => void = () => {}
    const r2Release = new Promise<void>((resolve) => {
      releaseR2 = resolve
    })
    let releaseR3: () => void = () => {}
    const r3Release = new Promise<void>((resolve) => {
      releaseR3 = resolve
    })

    client.onAuthStateChange(async (event, session) => {
      if (event === 'INITIAL_SESSION') {
        markInitialDelivered()
        return
      }
      if (event !== 'TOKEN_REFRESHED' || !session) return
      if (session.refresh_token === sessionR2.refresh_token) {
        markR2Started()
        await r2Release
      }
      if (session.refresh_token === sessionR3.refresh_token) {
        markR3Started()
        await r3Release
      }
    })
    await initialDelivered

    const refreshAccessToken = jest.fn(async () => {
      throw new Error('fieldwork no active notification result')
    })
    ;(client as any)._refreshAccessToken = refreshAccessToken

    const notifyR2 = (client as any)._notifyAllSubscribers(
      'TOKEN_REFRESHED',
      sessionR2,
      false
    )
    await r2Started
    expect((client as any).notifyingRefreshResults.get(sessionR2.refresh_token)).toMatchObject({
      result: { data: { refresh_token: sessionR2.refresh_token }, error: null },
      count: 1,
    })

    const notifyR3 = (client as any)._notifyAllSubscribers(
      'TOKEN_REFRESHED',
      sessionR3,
      false
    )
    await r3Started
    expect((client as any).notifyingRefreshResults.size).toBe(2)

    releaseR2()
    await notifyR2

    expect((client as any).notifyingRefreshResults.has(sessionR2.refresh_token)).toBe(false)
    expect((client as any).notifyingRefreshResults.has(sessionR3.refresh_token)).toBe(true)

    await expect(
      (client as any)._callRefreshToken(sessionR3.refresh_token)
    ).resolves.toMatchObject({
      data: { refresh_token: sessionR3.refresh_token },
      error: null,
    })
    expect(refreshAccessToken).not.toHaveBeenCalled()

    releaseR3()
    await notifyR3

    expect((client as any).notifyingRefreshResults.size).toBe(0)
    await expect(
      (client as any)._callRefreshToken(sessionR2.refresh_token)
    ).rejects.toThrow('fieldwork no active notification result')
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)

    await client.dispose()
  })

  test('same-token overlapping notifications remain active until every owner finishes', async () => {
    const client = new GoTrueClient({
      url: 'http://localhost:9999',
      storage: memoryLocalStorageAdapter(),
      storageKey: `fieldwork-overlap-map-same-${Date.now()}-${Math.random()}`,
      autoRefreshToken: false,
      persistSession: true,
      skipAutoInitialize: true,
    })
    await client.initialize()

    let markInitialDelivered: () => void = () => {}
    const initialDelivered = new Promise<void>((resolve) => {
      markInitialDelivered = resolve
    })
    const releases: Array<() => void> = []
    const started: Array<Promise<void>> = []

    client.onAuthStateChange(async (event) => {
      if (event === 'INITIAL_SESSION') {
        markInitialDelivered()
        return
      }
      if (event !== 'TOKEN_REFRESHED') return
      let markStarted: () => void = () => {}
      started.push(
        new Promise<void>((resolve) => {
          markStarted = resolve
        })
      )
      let release: () => void = () => {}
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      releases.push(release)
      markStarted()
      await wait
    })
    await initialDelivered

    const first = (client as any)._notifyAllSubscribers('TOKEN_REFRESHED', sessionR2, false)
    while (started.length < 1) await Promise.resolve()
    await started[0]
    const second = (client as any)._notifyAllSubscribers('TOKEN_REFRESHED', sessionR2, false)
    while (started.length < 2) await Promise.resolve()
    await started[1]

    expect((client as any).notifyingRefreshResults.get(sessionR2.refresh_token)?.count).toBe(2)

    releases[0]()
    await first
    expect((client as any).notifyingRefreshResults.get(sessionR2.refresh_token)?.count).toBe(1)

    releases[1]()
    await second
    expect((client as any).notifyingRefreshResults.has(sessionR2.refresh_token)).toBe(false)

    await client.dispose()
  })
})
