import { describe, expect, it, vi } from 'vitest'

import { createServerClient } from './createServerClient'
import { stringToBase64URL } from './utils'

const storageKey = 'sb-project-ref-auth-token'

const originalSession = {
  token_type: 'bearer',
  access_token: 'access-r1',
  refresh_token: 'refresh-r1',
  expires_at: Math.floor(Date.now() / 1000) - 60,
  expires_in: 0,
  user: { id: 'user-1', email: 'user@example.com' },
}

const rotatedSession = {
  token_type: 'bearer',
  access_token: 'access-r2',
  refresh_token: 'refresh-r2',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  expires_in: 3600,
  user: { id: 'user-1', email: 'user@example.com' },
}

const encodedSession = (session: typeof originalSession) =>
  `base64-${stringToBase64URL(JSON.stringify(session))}`

const refreshFetch = () =>
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/token?grant_type=refresh_token') && init?.method === 'POST') {
      return new Response(JSON.stringify(rotatedSession), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  })

const cookieEntries = (jar: Map<string, string>) =>
  [...jar].map(([name, value]) => ({ name, value }))

const applyCookies = (
  jar: Map<string, string>,
  cookiesToSet: Array<{ name: string; value: string }>
) => {
  for (const { name, value } of cookiesToSet) {
    if (value === '') jar.delete(name)
    else jar.set(name, value)
  }
}

describe('Fieldwork generation-5 @supabase/ssr integration', () => {
  it('awaits a writable asynchronous cookie adapter before refresh success', async () => {
    const jar = new Map([[storageKey, encodedSession(originalSession)]])
    const fetch = refreshFetch()
    let setAllCalls = 0
    let markSetAllStarted: () => void = () => {}
    const setAllStarted = new Promise<void>((resolve) => {
      markSetAllStarted = resolve
    })
    let releaseSetAll: () => void = () => {}
    const setAllRelease = new Promise<void>((resolve) => {
      releaseSetAll = resolve
    })

    const client = createServerClient('https://project-ref.supabase.co', 'anon-key', {
      cookies: {
        getAll: () => cookieEntries(jar),
        async setAll(cookiesToSet) {
          setAllCalls += 1
          markSetAllStarted()
          await setAllRelease
          applyCookies(jar, cookiesToSet)
        },
      },
      global: { fetch },
    })

    let settled = false
    const refreshing = client.auth.refreshSession().then((result) => {
      settled = true
      return result
    })

    await setAllStarted
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(setAllCalls).toBe(1)
    expect(jar.get(storageKey)).toBe(encodedSession(originalSession))

    releaseSetAll()
    const { data, error } = await refreshing

    expect(error).toBeNull()
    expect(data.session?.refresh_token).toBe(rotatedSession.refresh_token)
    expect(setAllCalls).toBe(1)
    expect(jar.get(storageKey)).not.toBe(encodedSession(originalSession))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps a throwing cookie writer visible after one committed token request', async () => {
    const jar = new Map([[storageKey, encodedSession(originalSession)]])
    const fetch = refreshFetch()
    let setAllCalls = 0

    const client = createServerClient('https://project-ref.supabase.co', 'anon-key', {
      cookies: {
        getAll: () => cookieEntries(jar),
        async setAll() {
          setAllCalls += 1
          throw new Error('fieldwork framework cookie write failed')
        },
      },
      global: { fetch },
    })

    await expect(client.auth.refreshSession()).rejects.toThrow(
      'fieldwork framework cookie write failed'
    )

    expect(setAllCalls).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(jar.get(storageKey)).toBe(encodedSession(originalSession))
  })

  it('treats an intentionally missing writer as a warned non-writing adapter, not a thrown persistence failure', async () => {
    const jar = new Map([[storageKey, encodedSession(originalSession)]])
    const fetch = refreshFetch()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const client = createServerClient('https://project-ref.supabase.co', 'anon-key', {
      cookies: {
        getAll: () => cookieEntries(jar),
      },
      global: { fetch },
    })

    const { data, error } = await client.auth.refreshSession()

    expect(error).toBeNull()
    expect(data.session?.refresh_token).toBe(rotatedSession.refresh_token)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(jar.get(storageKey)).toBe(encodedSession(originalSession))
    expect(warning).toHaveBeenCalled()
  })
})
