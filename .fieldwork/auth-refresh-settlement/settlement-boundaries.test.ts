import GoTrueClient from '../../packages/core/auth-js/src/GoTrueClient'
import type { Session } from '../../packages/core/auth-js/src'
import { setItemAsync } from '../../packages/core/auth-js/src/lib/helpers'
import { memoryLocalStorageAdapter } from '../../packages/core/auth-js/src/lib/local-storage'

const createClient = async (session?: Session) => {
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
  })
  await client.initialize()
  return { client, storage, storageKey }
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
