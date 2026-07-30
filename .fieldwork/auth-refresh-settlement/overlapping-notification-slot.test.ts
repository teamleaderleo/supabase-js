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

describe('Fieldwork overlapping notification result ownership', () => {
  test('single save-and-restore slot disappears during overlap and leaves a stale token afterward', async () => {
    const client = new GoTrueClient({
      url: 'http://localhost:9999',
      storage: memoryLocalStorageAdapter(),
      storageKey: `fieldwork-overlap-${Date.now()}-${Math.random()}`,
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

    const notifyR2 = (client as any)._notifyAllSubscribers(
      'TOKEN_REFRESHED',
      sessionR2,
      false
    )
    await r2Started
    expect((client as any).notifyingRefreshResult?.data?.refresh_token).toBe(
      sessionR2.refresh_token
    )

    const notifyR3 = (client as any)._notifyAllSubscribers(
      'TOKEN_REFRESHED',
      sessionR3,
      false
    )
    await r3Started
    expect((client as any).notifyingRefreshResult?.data?.refresh_token).toBe(
      sessionR3.refresh_token
    )

    releaseR2()
    await notifyR2

    // R3 is still notifying, but R2 restored the null value it observed before
    // R3 began. A nested R3 refresh would now miss the committed-result slot.
    expect((client as any).notifyingRefreshResult).toBeNull()

    releaseR3()
    await notifyR3

    // R3 restores the R2 value it observed when it began, leaving a stale
    // committed result available after every notification has completed.
    expect((client as any).notifyingRefreshResult?.data?.refresh_token).toBe(
      sessionR2.refresh_token
    )

    await client.dispose()
  })
})
