#!/usr/bin/env python3
"""Refine generation-5 notification ownership by current client generation."""

from pathlib import Path

SOURCE = Path("packages/core/auth-js/src/GoTrueClient.ts")


def replace_exact(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one exact anchor, found {count}")
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
  protected currentNotificationSessionGeneration: {
    refreshToken: string
    accessToken: string
    removalEpoch: number
  } | null = null
""",
    "client generation fields",
)

text = replace_exact(
    text,
    """    const notifyingRefresh = this.notifyingRefreshResults.get(refreshToken)
    if (notifyingRefresh) {
      return notifyingRefresh.result
    }

    // refreshing is already in progress
""",
    """    const currentGeneration = this.currentNotificationSessionGeneration
    const notifyingRefresh =
      currentGeneration?.refreshToken === refreshToken &&
      currentGeneration.removalEpoch === this._sessionRemovalEpoch
        ? this.notifyingRefreshResults
            .get(refreshToken)
            ?.get(currentGeneration.accessToken)
        : undefined
    if (notifyingRefresh) {
      return notifyingRefresh.result
    }

    // refreshing is already in progress
""",
    "client generation lookup",
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
    """    if (session) {
      this.currentNotificationSessionGeneration = {
        refreshToken: session.refresh_token,
        accessToken: session.access_token,
        removalEpoch: this._sessionRemovalEpoch,
      }
    } else if (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') {
      this.currentNotificationSessionGeneration = null
    }

    let notifyingRefreshKey: {
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
    "client generation notification registration",
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
    "client generation notification cleanup",
)

SOURCE.write_text(text, encoding="utf-8")
