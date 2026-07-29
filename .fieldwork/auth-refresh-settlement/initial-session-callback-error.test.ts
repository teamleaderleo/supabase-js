import GoTrueClient from '../../packages/core/auth-js/src/GoTrueClient'
import type { Session } from '../../packages/core/auth-js/src'
import { setItemAsync } from '../../packages/core/auth-js/src/lib/helpers'
import { memoryLocalStorageAdapter } from '../../packages/core/auth-js/src/lib/local-storage'

const session: Session = {
  access_token: 'access-r1',
  refresh_token: 'refresh-r1',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'user-1', email: 'user@example.com' } as any,
}

const outcomeWithin = async <T>(promise: PromiseLike<T>, timeoutMs = 250) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => 'finished' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe('Fieldwork INITIAL_SESSION callback error ownership', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('a callback failure is followed by a second INITIAL_SESSION delivery with null', async () => {
    const storage = memoryLocalStorageAdapter()
    const storageKey = `fieldwork-initial-session-${Date.now()}-${Math.random()}`
    await setItemAsync(storage, storageKey, session)

    const client = new GoTrueClient({
      url: 'http://localhost:9999',
      storage,
      storageKey,
      autoRefreshToken: false,
      persistSession: true,
      skipAutoInitialize: true,
    })
    await client.initialize()

    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    const observed: Array<string | null> = []
    let finish: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })

    client.onAuthStateChange(async (event, currentSession) => {
      if (event !== 'INITIAL_SESSION') return
      observed.push(currentSession?.refresh_token ?? null)
      if (currentSession) {
        throw new Error('initial session callback failed')
      }
      finish()
    })

    await expect(outcomeWithin(finished)).resolves.toBe('finished')

    expect(observed).toEqual([session.refresh_token, null])
    expect(consoleError).toHaveBeenCalledWith(new Error('initial session callback failed'))

    await client.dispose()
  })
})