#!/usr/bin/env python3
"""Refine generation-5 notification ownership by authoritative session generation."""

from pathlib import Path

SOURCE = Path("packages/core/auth-js/src/GoTrueClient.ts")


def replace_exact(text: str, old: str, new: str, label: str) -> str:
    if text.count(old) != 1:
        raise SystemExit(f"{label}: expected one exact anchor, found {text.count(old)}")
    return text.replace(old, new, 1)


text = SOURCE.read_text(encoding="utf-8")

text = replace_exact(
    text,
    """  protected notifyingRefreshResults = new Map<
    string,
    { result: CallRefreshTokenResult; count: number }
  >()
""",
    """  protected notifyingRefreshResults = new Map<
    string,
    Map<
      string,
      { result: CallRefreshTokenResult; count: number; removalEpoch: number }
    >
  >()
""",
    "generation-aware notification field",
)

text = replace_exact(
    text,
    """    const notifyingRefresh = this.notifyingRefreshResults.get(refreshToken)
    if (notifyingRefresh) {
      return notifyingRefresh.result
    }

    // refreshing is already in progress
""",
    """    const storedSession = (await getItemAsync(
      this.storage,
      this.storageKey
    )) as Session | null
    const notifyingRefresh =
      storedSession?.refresh_token === refreshToken
        ? this.notifyingRefreshResults
            .get(refreshToken)
            ?.get(storedSession.access_token)
        : undefined
    if (
      notifyingRefresh &&
      notifyingRefresh.removalEpoch === this._sessionRemovalEpoch
    ) {
      return notifyingRefresh.result
    }

    // refreshing is already in progress
""",
    "authoritative notification lookup",
)

text = replace_exact(
    text,
    """    let notifyingRefreshToken: string | null = null
    if (event === 'TOKEN_REFRESHED' && session) {
      notifyingRefreshToken = session.refresh_token
      const active = this.notifyingRefreshResults.get(notifyingRefreshToken)
      if (active) {
        active.count += 1
      } else {
        this.notifyingRefreshResults.set(notifyingRefreshToken, {
          result: { data: session, error: null },
          count: 1,
        })
      }
    }
""",
    """    let notifyingRefreshKey: {
      refreshToken: string
      accessToken: string
    } | null = null
    if (event === 'TOKEN_REFRESHED' && session) {
      notifyingRefreshKey = {
        refreshToken: session.refresh_token,
        accessToken: session.access_token,
      }
      let generations = this.notifyingRefreshResults.get(session.refresh_token)
      if (!generations) {
        generations = new Map()
        this.notifyingRefreshResults.set(session.refresh_token, generations)
      }
      const active = generations.get(session.access_token)
      if (active) {
        active.count += 1
      } else {
        generations.set(session.access_token, {
          result: { data: session, error: null },
          count: 1,
          removalEpoch: this._sessionRemovalEpoch,
        })
      }
    }
""",
    "generation-aware notification registration",
)

text = replace_exact(
    text,
    """      if (notifyingRefreshToken) {
        const active = this.notifyingRefreshResults.get(notifyingRefreshToken)
        if (active && active.count > 1) {
          active.count -= 1
        } else {
          this.notifyingRefreshResults.delete(notifyingRefreshToken)
        }
      }
""",
    """      if (notifyingRefreshKey) {
        const generations = this.notifyingRefreshResults.get(
          notifyingRefreshKey.refreshToken
        )
        const active = generations?.get(notifyingRefreshKey.accessToken)
        if (active && active.count > 1) {
          active.count -= 1
        } else {
          generations?.delete(notifyingRefreshKey.accessToken)
          if (generations?.size === 0) {
            this.notifyingRefreshResults.delete(notifyingRefreshKey.refreshToken)
          }
        }
      }
""",
    "generation-aware notification cleanup",
)

SOURCE.write_text(text, encoding="utf-8")
